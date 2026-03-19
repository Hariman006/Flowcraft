#!/usr/bin/env node
/**
 * FlowCraft — Single-file Workflow Engine
 * Backend: Express + Mongoose (MongoDB)
 * Frontend: Served inline as HTML string
 *
 * Usage:
 *   npm install express mongoose uuid
 *   MONGO_URI=mongodb://localhost:27017/flowcraft node server.js
 *
 * Default MONGO_URI: mongodb://localhost:27017/flowcraft
 * Default PORT: 3000
 */

const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/flowcraft';
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// MONGOOSE SCHEMAS
// ─────────────────────────────────────────────

const WorkflowSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  name: { type: String, required: true },
  description: String,
  version: { type: Number, default: 1 },
  is_active: { type: Boolean, default: true },
  input_schema: { type: mongoose.Schema.Types.Mixed, default: {} },
  start_step_id: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const StepSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  workflow_id: { type: String, required: true, index: true },
  name: { type: String, required: true },
  step_type: { type: String, enum: ['task', 'approval', 'notification'], required: true },
  order: { type: Number, default: 0 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const RuleSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  step_id: { type: String, required: true, index: true },
  condition: { type: String, required: true },
  next_step_id: { type: String, default: null },
  priority: { type: Number, default: 1 },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const StepLogSchema = new mongoose.Schema({
  step_id: String,
  step_name: String,
  step_type: String,
  evaluated_rules: [{ rule: String, result: Boolean }],
  selected_next_step: String,
  status: String,
  approver_id: String,
  error_message: String,
  started_at: String,
  ended_at: String,
}, { _id: false });

const ExecutionSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  workflow_id: { type: String, required: true, index: true },
  workflow_version: Number,
  status: { type: String, enum: ['pending','in_progress','completed','failed','canceled'], default: 'pending' },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  logs: [StepLogSchema],
  current_step_id: { type: String, default: null },
  retries: { type: Number, default: 0 },
  triggered_by: String,
  started_at: String,
  ended_at: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const Workflow  = mongoose.model('Workflow',  WorkflowSchema);
const Step      = mongoose.model('Step',      StepSchema);
const Rule      = mongoose.model('Rule',      RuleSchema);
const Execution = mongoose.model('Execution', ExecutionSchema);

// ─────────────────────────────────────────────
// RULE ENGINE
// ─────────────────────────────────────────────

function evaluateCondition(condition, data) {
  if (condition.trim().toUpperCase() === 'DEFAULT') return true;
  try {
    let expr = condition
      .replace(/contains\((\w+),\s*['"](.+?)['"]\)/g, (_,f,v) => `(String(data['${f}']||'').includes('${v}'))`)
      .replace(/startsWith\((\w+),\s*['"](.+?)['"]\)/g, (_,f,v) => `(String(data['${f}']||'').startsWith('${v}'))`)
      .replace(/endsWith\((\w+),\s*['"](.+?)['"]\)/g, (_,f,v) => `(String(data['${f}']||'').endsWith('${v}'))`)
      .replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b(?!\s*[\[('"])/g, (match) => {
        const reserved = ['true','false','null','undefined','String','Number','Boolean'];
        return reserved.includes(match) ? match : `data['${match}']`;
      });
    const fn = new Function('data', `"use strict"; try { return !!(${expr}); } catch(e){ return false; }`);
    return fn(data);
  } catch(e) { return false; }
}

async function advanceExecution(exec) {
  if (exec.status !== 'in_progress' || !exec.current_step_id) return exec;
  const step = await Step.findById(exec.current_step_id);
  if (!step) { exec.status = 'failed'; exec.ended_at = new Date().toISOString(); await exec.save(); return exec; }
  if (step.step_type === 'approval') return exec;

  const rules = await Rule.find({ step_id: step._id }).sort({ priority: 1 });
  const logEntry = {
    step_id: step._id, step_name: step.name, step_type: step.step_type,
    evaluated_rules: [], selected_next_step: null,
    status: 'completed', approver_id: null, error_message: null,
    started_at: new Date().toISOString(), ended_at: null,
  };

  let nextStepId = null, matched = false;
  for (const r of rules) {
    const result = evaluateCondition(r.condition, exec.data);
    logEntry.evaluated_rules.push({ rule: r.condition, result });
    if (!matched && result) {
      nextStepId = r.next_step_id;
      if (nextStepId) {
        const ns = await Step.findById(nextStepId);
        logEntry.selected_next_step = ns?.name || nextStepId;
      } else {
        logEntry.selected_next_step = 'End Workflow';
      }
      matched = true;
    }
  }

  if (!matched && rules.length > 0) {
    logEntry.status = 'failed';
    logEntry.error_message = 'No matching rule found';
  }
  logEntry.ended_at = new Date().toISOString();
  exec.logs.push(logEntry);
  exec.current_step_id = logEntry.status === 'failed' ? null : nextStepId;
  if (logEntry.status === 'failed') { exec.status = 'failed'; exec.ended_at = new Date().toISOString(); }
  else if (!nextStepId) { exec.status = 'completed'; exec.ended_at = new Date().toISOString(); }
  await exec.save();
  if (exec.status === 'in_progress' && exec.current_step_id) return advanceExecution(exec);
  return exec;
}

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

// ── Workflows ──
app.post('/api/workflows', async (req, res) => {
  try {
    const wf = new Workflow({ _id: uuidv4(), ...req.body });
    await wf.save();
    res.status(201).json(wf);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/workflows', async (req, res) => {
  try {
    const { search = '', status, page = 1, limit = 50 } = req.query;
    const query = {};
    if (search) query.name = { $regex: search, $options: 'i' };
    if (status !== undefined && status !== '') query.is_active = status === 'true';
    const workflows = await Workflow.find(query).sort({ created_at: -1 }).skip((page-1)*limit).limit(Number(limit));
    const total = await Workflow.countDocuments(query);
    const ids = workflows.map(w => w._id);
    const counts = await Step.aggregate([{ $match: { workflow_id: { $in: ids } } }, { $group: { _id: '$workflow_id', count: { $sum: 1 } } }]);
    const countMap = {};
    counts.forEach(c => countMap[c._id] = c.count);
    const data = workflows.map(w => ({ ...w.toObject(), id: w._id, step_count: countMap[w._id] || 0 }));
    res.json({ data, total, page: Number(page) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/workflows/:id', async (req, res) => {
  try {
    const wf = await Workflow.findById(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Not found' });
    const steps = await Step.find({ workflow_id: wf._id }).sort({ order: 1 });
    const stepIds = steps.map(s => s._id);
    const rules = await Rule.find({ step_id: { $in: stepIds } }).sort({ priority: 1 });
    res.json({ ...wf.toObject(), id: wf._id, steps: steps.map(s => ({...s.toObject(),id:s._id})), rules: rules.map(r => ({...r.toObject(),id:r._id})) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/workflows/:id', async (req, res) => {
  try {
    const wf = await Workflow.findById(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Not found' });
    Object.assign(wf, req.body);
    wf.version += 1;
    await wf.save();
    res.json({ ...wf.toObject(), id: wf._id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/workflows/:id', async (req, res) => {
  try {
    const steps = await Step.find({ workflow_id: req.params.id });
    const stepIds = steps.map(s => s._id);
    await Rule.deleteMany({ step_id: { $in: stepIds } });
    await Step.deleteMany({ workflow_id: req.params.id });
    await Workflow.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Steps ──
app.post('/api/workflows/:workflow_id/steps', async (req, res) => {
  try {
    const wf = await Workflow.findById(req.params.workflow_id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const count = await Step.countDocuments({ workflow_id: wf._id });
    const step = new Step({ _id: uuidv4(), workflow_id: wf._id, order: count + 1, ...req.body });
    await step.save();
    if (!wf.start_step_id) { wf.start_step_id = step._id; await wf.save(); }
    res.status(201).json({ ...step.toObject(), id: step._id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/workflows/:workflow_id/steps', async (req, res) => {
  try {
    const steps = await Step.find({ workflow_id: req.params.workflow_id }).sort({ order: 1 });
    res.json(steps.map(s => ({ ...s.toObject(), id: s._id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/steps/:id', async (req, res) => {
  try {
    const step = await Step.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!step) return res.status(404).json({ error: 'Not found' });
    res.json({ ...step.toObject(), id: step._id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/steps/:id', async (req, res) => {
  try {
    await Rule.deleteMany({ step_id: req.params.id });
    const step = await Step.findByIdAndDelete(req.params.id);
    if (!step) return res.status(404).json({ error: 'Not found' });
    const wf = await Workflow.findById(step.workflow_id);
    if (wf && wf.start_step_id === req.params.id) {
      const first = await Step.findOne({ workflow_id: wf._id }).sort({ order: 1 });
      wf.start_step_id = first ? first._id : null;
      await wf.save();
    }
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Rules ──
app.post('/api/steps/:step_id/rules', async (req, res) => {
  try {
    const rule = new Rule({ _id: uuidv4(), step_id: req.params.step_id, ...req.body });
    await rule.save();
    res.status(201).json({ ...rule.toObject(), id: rule._id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/steps/:step_id/rules', async (req, res) => {
  try {
    const rules = await Rule.find({ step_id: req.params.step_id }).sort({ priority: 1 });
    res.json(rules.map(r => ({ ...r.toObject(), id: r._id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/rules/:id', async (req, res) => {
  try {
    const rule = await Rule.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!rule) return res.status(404).json({ error: 'Not found' });
    res.json({ ...rule.toObject(), id: rule._id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/rules/:id', async (req, res) => {
  try {
    await Rule.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Executions ──
app.post('/api/workflows/:workflow_id/execute', async (req, res) => {
  try {
    const wf = await Workflow.findById(req.params.workflow_id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    if (!wf.start_step_id) return res.status(400).json({ error: 'Workflow has no steps' });
    const exec = new Execution({
      _id: uuidv4(),
      workflow_id: wf._id, workflow_version: wf.version,
      status: 'in_progress', data: req.body.data || {},
      current_step_id: wf.start_step_id,
      triggered_by: req.body.triggered_by || 'user-api',
      started_at: new Date().toISOString(),
    });
    await exec.save();
    const updated = await advanceExecution(exec);
    res.status(201).json({ ...updated.toObject(), id: updated._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/executions', async (req, res) => {
  try {
    const { search = '', status, page = 1, limit = 50 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (search) {
      const wfs = await Workflow.find({ name: { $regex: search, $options: 'i' } });
      query.workflow_id = { $in: wfs.map(w => w._id) };
    }
    const executions = await Execution.find(query).sort({ created_at: -1 }).skip((page-1)*limit).limit(Number(limit));
    const total = await Execution.countDocuments(query);
    res.json({ data: executions.map(e => ({ ...e.toObject(), id: e._id })), total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/executions/:id', async (req, res) => {
  try {
    const exec = await Execution.findById(req.params.id);
    if (!exec) return res.status(404).json({ error: 'Not found' });
    res.json({ ...exec.toObject(), id: exec._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/executions/:id/cancel', async (req, res) => {
  try {
    const exec = await Execution.findById(req.params.id);
    if (!exec) return res.status(404).json({ error: 'Not found' });
    if (!['in_progress','pending'].includes(exec.status)) return res.status(400).json({ error: 'Cannot cancel' });
    exec.status = 'canceled'; exec.ended_at = new Date().toISOString();
    await exec.save();
    res.json({ ...exec.toObject(), id: exec._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/executions/:id/retry', async (req, res) => {
  try {
    const exec = await Execution.findById(req.params.id);
    if (!exec) return res.status(404).json({ error: 'Not found' });
    if (exec.status !== 'failed') return res.status(400).json({ error: 'Only failed executions can be retried' });
    const failedLog = [...exec.logs].reverse().find(l => l.status === 'failed' || l.status === 'rejected');
    if (!failedLog) return res.status(400).json({ error: 'No failed step found' });
    exec.logs = exec.logs.filter(l => l.step_id !== failedLog.step_id);
    exec.current_step_id = failedLog.step_id;
    exec.status = 'in_progress'; exec.retries += 1; exec.ended_at = null;
    await exec.save();
    const updated = await advanceExecution(exec);
    res.json({ ...updated.toObject(), id: updated._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/executions/:id/approve', async (req, res) => {
  try {
    const exec = await Execution.findById(req.params.id);
    if (!exec || exec.status !== 'in_progress') return res.status(400).json({ error: 'Execution not in progress' });
    const step = await Step.findById(exec.current_step_id);
    if (!step || step.step_type !== 'approval') return res.status(400).json({ error: 'Current step is not an approval' });
    const { decision, approver_id } = req.body;
    const rules = await Rule.find({ step_id: step._id }).sort({ priority: 1 });
    const logEntry = {
      step_id: step._id, step_name: step.name, step_type: step.step_type,
      evaluated_rules: [], selected_next_step: null,
      status: decision === 'approve' ? 'completed' : 'rejected',
      approver_id: approver_id || 'unknown',
      error_message: decision === 'reject' ? 'Rejected by approver' : null,
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    };
    if (decision === 'approve') {
      let nextStepId = null, matched = false;
      for (const r of rules) {
        const result = evaluateCondition(r.condition, exec.data);
        logEntry.evaluated_rules.push({ rule: r.condition, result });
        if (!matched && result) {
          nextStepId = r.next_step_id;
          if (nextStepId) { const ns = await Step.findById(nextStepId); logEntry.selected_next_step = ns?.name || nextStepId; }
          else logEntry.selected_next_step = 'End Workflow';
          matched = true;
        }
      }
      exec.logs.push(logEntry);
      exec.current_step_id = nextStepId;
      if (!nextStepId) { exec.status = 'completed'; exec.ended_at = new Date().toISOString(); }
      await exec.save();
      if (exec.status === 'in_progress') await advanceExecution(exec);
    } else {
      exec.logs.push(logEntry);
      exec.status = 'failed'; exec.ended_at = new Date().toISOString(); exec.current_step_id = null;
      await exec.save();
    }
    const fresh = await Execution.findById(exec._id);
    res.json({ ...fresh.toObject(), id: fresh._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const [workflows, executions, completed, failed] = await Promise.all([
      Workflow.countDocuments(),
      Execution.countDocuments(),
      Execution.countDocuments({ status: 'completed' }),
      Execution.countDocuments({ status: 'failed' }),
    ]);
    res.json({ workflows, executions, completed, failed });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// SEED SAMPLE DATA
// ─────────────────────────────────────────────
async function fixExpenseApprovalRules() {
  try {
    const wf = await Workflow.findOne({ name: 'Expense Approval' });
    if (!wf) return;
    const [s1, s2, s3, s4] = await Promise.all([
      Step.findOne({ workflow_id: wf._id, name: 'Manager Approval' }),
      Step.findOne({ workflow_id: wf._id, name: 'Finance Notification' }),
      Step.findOne({ workflow_id: wf._id, name: 'CEO Approval' }),
      Step.findOne({ workflow_id: wf._id, name: 'Task Rejection' }),
    ]);
    if (!s1 || !s2 || !s3 || !s4) return;
    await Rule.deleteMany({ step_id: { $in: [s1._id, s2._id, s3._id, s4._id] } });
    await Rule.insertMany([
      { _id: require('uuid').v4(), step_id: s1._id, condition: "amount > 100 && country == 'US' && priority == 'High'", next_step_id: s2._id, priority: 1 },
      { _id: require('uuid').v4(), step_id: s1._id, condition: "amount <= 100 || department == 'HR'", next_step_id: s3._id, priority: 2 },
      { _id: require('uuid').v4(), step_id: s1._id, condition: "priority == 'Low' && country != 'US'", next_step_id: s4._id, priority: 3 },
      { _id: require('uuid').v4(), step_id: s1._id, condition: 'DEFAULT', next_step_id: s4._id, priority: 4 },
      { _id: require('uuid').v4(), step_id: s2._id, condition: 'amount > 10000', next_step_id: s3._id, priority: 1 },
      { _id: require('uuid').v4(), step_id: s2._id, condition: 'DEFAULT', next_step_id: s3._id, priority: 2 },
      { _id: require('uuid').v4(), step_id: s3._id, condition: 'DEFAULT', next_step_id: null, priority: 1 },
      { _id: require('uuid').v4(), step_id: s4._id, condition: 'DEFAULT', next_step_id: null, priority: 1 },
    ]);
    console.log('✅ Expense Approval rules fixed');
  } catch(e) { console.log('Migration note:', e.message); }
}

async function seedSampleData() {
  const existing = await Workflow.countDocuments();
  if (existing > 0) { await fixExpenseApprovalRules(); return; }
  console.log('🌱 Seeding sample workflows...');

  const wf1 = new Workflow({
    _id: uuidv4(), name: 'Expense Approval', description: 'Multi-level expense approval process',
    version: 3, is_active: true,
    input_schema: {
      amount: { type: 'number', required: true },
      country: { type: 'string', required: true },
      department: { type: 'string', required: false },
      priority: { type: 'string', required: true, allowed_values: ['High', 'Medium', 'Low'] }
    }
  });
  const s1 = new Step({ _id: uuidv4(), workflow_id: wf1._id, name: 'Manager Approval', step_type: 'approval', order: 1, metadata: { assignee_email: 'manager@example.com', instructions: 'Review and approve or reject the expense.' } });
  const s2 = new Step({ _id: uuidv4(), workflow_id: wf1._id, name: 'Finance Notification', step_type: 'notification', order: 2, metadata: { assignee_email: 'finance@example.com', notification_channel: 'email' } });
  const s3 = new Step({ _id: uuidv4(), workflow_id: wf1._id, name: 'CEO Approval', step_type: 'approval', order: 3, metadata: { assignee_email: 'ceo@example.com', instructions: 'Final sign-off for high-value expenses.' } });
  const s4 = new Step({ _id: uuidv4(), workflow_id: wf1._id, name: 'Task Rejection', step_type: 'task', order: 4, metadata: { instructions: 'Log rejection and notify requester.' } });
  wf1.start_step_id = s1._id;
  await wf1.save(); await s1.save(); await s2.save(); await s3.save(); await s4.save();
  await Rule.insertMany([
    { _id: uuidv4(), step_id: s1._id, condition: "amount > 100 && country == 'US' && priority == 'High'", next_step_id: s2._id, priority: 1 },
    { _id: uuidv4(), step_id: s1._id, condition: "amount <= 100 || department == 'HR'", next_step_id: s3._id, priority: 2 },
    { _id: uuidv4(), step_id: s1._id, condition: "priority == 'Low' && country != 'US'", next_step_id: s4._id, priority: 3 },
    { _id: uuidv4(), step_id: s1._id, condition: 'DEFAULT', next_step_id: s4._id, priority: 4 },
    { _id: uuidv4(), step_id: s2._id, condition: 'amount > 10000', next_step_id: s3._id, priority: 1 },
    { _id: uuidv4(), step_id: s2._id, condition: 'DEFAULT', next_step_id: s3._id, priority: 2 },
    { _id: uuidv4(), step_id: s3._id, condition: 'DEFAULT', next_step_id: null, priority: 1 },
    { _id: uuidv4(), step_id: s4._id, condition: 'DEFAULT', next_step_id: null, priority: 1 },
  ]);

  const wf2 = new Workflow({
    _id: uuidv4(), name: 'Employee Onboarding', description: 'New hire onboarding process',
    version: 1, is_active: true,
    input_schema: {
      employee_name: { type: 'string', required: true },
      department: { type: 'string', required: true },
      role: { type: 'string', required: true },
      senior: { type: 'boolean', required: false }
    }
  });
  const t1 = new Step({ _id: uuidv4(), workflow_id: wf2._id, name: 'Send Welcome Email', step_type: 'notification', order: 1, metadata: { notification_channel: 'email' } });
  const t2 = new Step({ _id: uuidv4(), workflow_id: wf2._id, name: 'IT Setup Task', step_type: 'task', order: 2, metadata: { instructions: 'Provision accounts and laptop.' } });
  const t3 = new Step({ _id: uuidv4(), workflow_id: wf2._id, name: 'HR Manager Approval', step_type: 'approval', order: 3, metadata: { assignee_email: 'hr@example.com' } });
  wf2.start_step_id = t1._id;
  await wf2.save(); await t1.save(); await t2.save(); await t3.save();
  await Rule.insertMany([
    { _id: uuidv4(), step_id: t1._id, condition: 'DEFAULT', next_step_id: t2._id, priority: 1 },
    { _id: uuidv4(), step_id: t2._id, condition: 'DEFAULT', next_step_id: t3._id, priority: 1 },
    { _id: uuidv4(), step_id: t3._id, condition: 'DEFAULT', next_step_id: null, priority: 1 },
  ]);
  console.log('✅ Sample data seeded.');
}

// ─────────────────────────────────────────────
// FRONTEND HTML — Modern Enterprise Dark
// ─────────────────────────────────────────────
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FlowCraft — Workflow Engine</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Syne:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
/* ── DESIGN TOKENS ── */
:root {
  --bg-0: #0e0e10;
  --bg-1: #141416;
  --bg-2: #1a1a1e;
  --bg-3: #222228;
  --bg-4: #2a2a32;

  --green: #b8f04a;
  --green-dim: rgba(184,240,74,.12);
  --green-glow: rgba(184,240,74,.25);
  --green-mid: rgba(184,240,74,.5);
  --green-muted: rgba(184,240,74,.35);

  --text-0: #f0f0f2;
  --text-1: #a8a8b4;
  --text-2: #68687a;
  --text-3: #44444e;

  --border-0: rgba(255,255,255,.06);
  --border-1: rgba(255,255,255,.1);
  --border-green: rgba(184,240,74,.3);

  --red: #ff5f5f;
  --red-dim: rgba(255,95,95,.12);
  --amber: #ffb347;
  --amber-dim: rgba(255,179,71,.12);
  --blue: #64b5f6;
  --blue-dim: rgba(100,181,246,.12);

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;

  --font-ui: 'Syne', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;

  --shadow-sm: 0 2px 8px rgba(0,0,0,.4);
  --shadow-md: 0 4px 20px rgba(0,0,0,.6);
  --shadow-lg: 0 12px 48px rgba(0,0,0,.8);
  --shadow-green: 0 0 20px rgba(184,240,74,.15);
}

/* ── RESET ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 14px; }
body {
  font-family: var(--font-ui);
  background: var(--bg-0);
  color: var(--text-0);
  min-height: 100vh;
  display: flex;
  overflow: hidden;
}

/* ── SCROLLBAR ── */
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--bg-4); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: var(--green-muted); }

/* ── SIDEBAR ── */
.sidebar {
  width: 220px;
  min-width: 220px;
  background: var(--bg-1);
  border-right: 1px solid var(--border-0);
  display: flex;
  flex-direction: column;
  padding: 0;
  z-index: 10;
  position: relative;
}

.sidebar::after {
  content: '';
  position: absolute;
  top: 0; right: 0;
  width: 1px; height: 100%;
  background: linear-gradient(180deg, transparent, var(--border-green) 40%, transparent);
  pointer-events: none;
}

.sidebar-logo {
  padding: 24px 20px 20px;
  border-bottom: 1px solid var(--border-0);
  margin-bottom: 8px;
}

.brand {
  font-family: var(--font-ui);
  font-size: 1.3rem;
  font-weight: 800;
  color: var(--text-0);
  letter-spacing: -1px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.brand-dot {
  width: 8px;
  height: 8px;
  background: var(--green);
  border-radius: 50%;
  box-shadow: 0 0 8px var(--green);
  animation: pulse-dot 2s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; box-shadow: 0 0 8px var(--green); }
  50% { opacity: .7; box-shadow: 0 0 16px var(--green), 0 0 32px var(--green-glow); }
}

.tagline {
  font-size: .68rem;
  font-weight: 500;
  color: var(--text-2);
  letter-spacing: 2px;
  text-transform: uppercase;
  margin-top: 4px;
  font-family: var(--font-mono);
}

.nav-section {
  padding: 16px 20px 6px;
  font-size: .65rem;
  font-weight: 600;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text-3);
  font-family: var(--font-mono);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 20px;
  cursor: pointer;
  color: var(--text-1);
  font-size: .82rem;
  font-weight: 500;
  border-left: 2px solid transparent;
  transition: all .18s ease;
  user-select: none;
  position: relative;
}

.nav-item:hover {
  color: var(--text-0);
  background: var(--bg-2);
}

.nav-item.active {
  color: var(--green);
  border-left-color: var(--green);
  background: var(--green-dim);
}

.nav-icon {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: .9rem;
  opacity: .8;
  flex-shrink: 0;
}

.nav-item.active .nav-icon { opacity: 1; }

.sidebar-footer {
  margin-top: auto;
  padding: 16px 20px;
  border-top: 1px solid var(--border-0);
  font-size: .72rem;
  font-family: var(--font-mono);
  color: var(--text-3);
}

.version-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--green-dim);
  border: 1px solid var(--border-green);
  color: var(--green);
  padding: 3px 8px;
  border-radius: 4px;
  font-size: .68rem;
  font-weight: 600;
  font-family: var(--font-mono);
  margin-bottom: 6px;
}

/* ── MAIN LAYOUT ── */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-0);
}

/* ── TOPBAR ── */
.topbar {
  background: var(--bg-1);
  border-bottom: 1px solid var(--border-0);
  padding: 0 28px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.topbar-title {
  font-size: .82rem;
  font-weight: 600;
  color: var(--text-1);
  font-family: var(--font-mono);
  letter-spacing: .5px;
}

.topbar-title span {
  color: var(--green);
}

/* ── PAGES ── */
.page {
  display: none;
  flex: 1;
  overflow-y: auto;
  padding: 24px 28px;
  flex-direction: column;
  gap: 18px;
}
.page.active { display: flex; }

/* ── CARDS ── */
.card {
  background: var(--bg-1);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-0);
  padding: 20px;
  transition: border-color .2s;
}
.card:hover { border-color: var(--border-1); }

.card-title {
  font-size: .82rem;
  font-weight: 700;
  color: var(--text-1);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  font-family: var(--font-mono);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-title::before {
  content: '';
  width: 3px;
  height: 14px;
  background: var(--green);
  border-radius: 2px;
  box-shadow: 0 0 6px var(--green-glow);
}

/* ── BUTTONS ── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  font-family: var(--font-ui);
  font-size: .8rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all .18s ease;
  white-space: nowrap;
  letter-spacing: .3px;
}

.btn-primary {
  background: var(--green);
  color: #0e0e10;
}
.btn-primary:hover {
  background: #cdf766;
  transform: translateY(-1px);
  box-shadow: 0 4px 16px var(--green-glow);
}

.btn-ghost {
  background: transparent;
  color: var(--text-1);
  border: 1px solid var(--border-1);
}
.btn-ghost:hover {
  background: var(--bg-3);
  color: var(--text-0);
  border-color: var(--border-1);
}

.btn-danger {
  background: var(--red-dim);
  color: var(--red);
  border: 1px solid rgba(255,95,95,.2);
}
.btn-danger:hover {
  background: rgba(255,95,95,.2);
}

.btn-sm { padding: 5px 12px; font-size: .76rem; }
.btn-xs { padding: 3px 8px; font-size: .72rem; border-radius: 4px; }

/* ── SKELETON LOADERS ── */
@keyframes shimmer {
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
}

.skeleton {
  background: linear-gradient(90deg, var(--bg-2) 25%, var(--bg-3) 50%, var(--bg-2) 75%);
  background-size: 800px 100%;
  animation: shimmer 1.4s ease-in-out infinite;
  border-radius: var(--radius-sm);
}

.skel-stat { height: 64px; border-radius: var(--radius-md); }
.skel-row { height: 40px; margin-bottom: 8px; }
.skel-text { height: 14px; margin-bottom: 6px; }

/* ── STAT CARDS ── */
.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.stat-card {
  background: var(--bg-1);
  border-radius: var(--radius-lg);
  padding: 20px;
  border: 1px solid var(--border-0);
  position: relative;
  overflow: hidden;
  transition: border-color .2s, transform .2s;
}

.stat-card:hover {
  border-color: var(--border-green);
  transform: translateY(-2px);
  box-shadow: var(--shadow-green);
}

.stat-card::after {
  content: '';
  position: absolute;
  top: 0; right: 0;
  width: 40%;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--green-muted));
  pointer-events: none;
}

.stat-label {
  font-size: .68rem;
  font-weight: 600;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  font-family: var(--font-mono);
  margin-bottom: 8px;
}

.stat-value {
  font-family: var(--font-mono);
  font-size: 2.4rem;
  font-weight: 700;
  color: var(--text-0);
  line-height: 1;
  letter-spacing: -2px;
}

.stat-value.green { color: var(--green); text-shadow: 0 0 20px var(--green-glow); }
.stat-value.red { color: var(--red); }

.stat-sub {
  font-size: .7rem;
  color: var(--text-2);
  margin-top: 6px;
  font-family: var(--font-mono);
}

/* ── INPUTS ── */
.input-wrap { position: relative; flex: 1; }
.input-wrap input, .input-wrap select {
  width: 100%;
  padding: 8px 12px 8px 34px;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: .8rem;
  background: var(--bg-2);
  color: var(--text-0);
  outline: none;
  transition: all .18s;
}
.input-wrap input:focus, .input-wrap select:focus {
  border-color: var(--green);
  background: var(--bg-3);
  box-shadow: 0 0 0 3px var(--green-dim);
}
.input-wrap .icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-2);
  font-size: .85rem;
}

/* ── FORM ELEMENTS ── */
.form-row { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
.form-label {
  font-size: .72rem;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 1px;
  text-transform: uppercase;
  font-family: var(--font-mono);
}
.form-input {
  padding: 8px 12px;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: .82rem;
  background: var(--bg-2);
  color: var(--text-0);
  outline: none;
  transition: all .18s;
  width: 100%;
}
.form-input:focus {
  border-color: var(--green);
  background: var(--bg-3);
  box-shadow: 0 0 0 3px var(--green-dim);
}
textarea.form-input { resize: vertical; min-height: 80px; }
.form-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-hint { font-size: .7rem; color: var(--text-2); margin-top: 3px; font-family: var(--font-mono); }

/* ── TABLES ── */
table { width: 100%; border-collapse: collapse; }
thead th {
  background: var(--bg-2);
  color: var(--text-2);
  font-size: .68rem;
  font-weight: 600;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  padding: 10px 14px;
  text-align: left;
  border-bottom: 1px solid var(--border-0);
  font-family: var(--font-mono);
}
tbody tr { border-bottom: 1px solid var(--border-0); transition: .18s; }
tbody tr:hover { background: var(--bg-2); }
tbody td { padding: 11px 14px; font-size: .82rem; vertical-align: middle; }

/* ── BADGES ── */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: .68rem;
  font-weight: 600;
  letter-spacing: .5px;
  text-transform: uppercase;
  font-family: var(--font-mono);
}
.badge::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .7; }

.badge-active { background: rgba(184,240,74,.12); color: var(--green); border: 1px solid rgba(184,240,74,.2); }
.badge-inactive { background: var(--red-dim); color: var(--red); border: 1px solid rgba(255,95,95,.2); }
.badge-pending { background: var(--amber-dim); color: var(--amber); border: 1px solid rgba(255,179,71,.2); }
.badge-completed { background: rgba(184,240,74,.12); color: var(--green); border: 1px solid rgba(184,240,74,.2); }
.badge-failed { background: var(--red-dim); color: var(--red); border: 1px solid rgba(255,95,95,.2); }
.badge-in_progress { background: var(--blue-dim); color: var(--blue); border: 1px solid rgba(100,181,246,.2); }
.badge-canceled { background: var(--bg-3); color: var(--text-2); border: 1px solid var(--border-0); }
.badge-rejected { background: var(--red-dim); color: var(--red); border: 1px solid rgba(255,95,95,.2); }
.badge-task { background: var(--amber-dim); color: var(--amber); border: 1px solid rgba(255,179,71,.2); }
.badge-approval { background: var(--blue-dim); color: var(--blue); border: 1px solid rgba(100,181,246,.2); }
.badge-notification { background: rgba(160,110,255,.12); color: #b494ff; border: 1px solid rgba(160,110,255,.2); }

.actions-cell { display: flex; gap: 6px; flex-wrap: wrap; }
.uuid-cell {
  font-family: var(--font-mono);
  font-size: .72rem;
  color: var(--text-2);
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── TOGGLE ── */
.toggle {
  width: 36px; height: 20px;
  background: var(--bg-4);
  border-radius: 20px;
  position: relative;
  cursor: pointer;
  transition: .3s;
  border: 1px solid var(--border-1);
  flex-shrink: 0;
}
.toggle.on {
  background: var(--green);
  border-color: var(--green);
  box-shadow: 0 0 8px var(--green-glow);
}
.toggle::after {
  content: '';
  position: absolute;
  left: 3px; top: 3px;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: var(--text-1);
  transition: .3s;
}
.toggle.on::after { left: 19px; background: #0e0e10; }

/* ── MODALS ── */
.modal-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,.75);
  display: flex; align-items: center; justify-content: center;
  backdrop-filter: blur(8px);
  opacity: 0; pointer-events: none;
  transition: opacity .2s;
}
.modal-overlay.open { opacity: 1; pointer-events: all; }
.modal {
  background: var(--bg-1);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border-1);
  width: 520px; max-width: 95vw; max-height: 90vh;
  overflow-y: auto; padding: 24px;
  transform: translateY(16px) scale(.98);
  transition: transform .22s;
}
.modal-overlay.open .modal { transform: translateY(0) scale(1); }
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 20px; padding-bottom: 14px;
  border-bottom: 1px solid var(--border-0);
}
.modal-title {
  font-size: .95rem;
  font-weight: 700;
  color: var(--text-0);
}
.modal-close {
  background: var(--bg-3); border: 1px solid var(--border-1);
  border-radius: 50%; width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--text-1); font-size: .85rem;
  transition: .18s;
}
.modal-close:hover { background: var(--bg-4); color: var(--text-0); }
.modal-footer {
  display: flex; gap: 8px; justify-content: flex-end;
  margin-top: 20px; padding-top: 14px;
  border-top: 1px solid var(--border-0);
}

/* ── STEP CARDS ── */
.step-card {
  background: var(--bg-2);
  border: 1px solid var(--border-0);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  display: flex; align-items: center; gap: 12px;
  margin-bottom: 6px;
  transition: all .18s;
}
.step-card:hover {
  border-color: var(--border-green);
  box-shadow: 0 0 12px var(--green-dim);
}
.step-order {
  width: 26px; height: 26px;
  background: var(--bg-4);
  border: 1px solid var(--border-1);
  color: var(--green);
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: .75rem; font-weight: 700;
  font-family: var(--font-mono);
  flex-shrink: 0;
}
.step-info { flex: 1; }
.step-name { font-weight: 600; font-size: .85rem; }

/* ── RULE ROWS ── */
.rule-row {
  display: grid;
  grid-template-columns: 42px 1fr 160px 72px;
  gap: 8px; align-items: center;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  margin-bottom: 5px;
  border: 1px solid var(--border-0);
  transition: .18s;
}
.rule-row:hover { border-color: var(--border-green); }
.rule-priority {
  width: 32px; height: 26px;
  background: var(--bg-4);
  border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  font-size: .75rem; font-weight: 700;
  color: var(--green);
  font-family: var(--font-mono);
}
.rule-condition {
  font-family: var(--font-mono);
  font-size: .76rem;
  color: var(--text-1);
  background: var(--bg-0);
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--border-0);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rule-condition.default { color: var(--green); font-weight: 600; }

/* ── EXECUTION FLOW DIAGRAM ── */
.flow-diagram {
  display: flex;
  align-items: flex-start;
  gap: 0;
  padding: 16px 0;
  overflow-x: auto;
  position: relative;
}

.flow-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  flex-shrink: 0;
}

.flow-connector {
  display: flex;
  align-items: center;
  padding-top: 22px;
  flex-shrink: 0;
}

.flow-connector-line {
  width: 40px;
  height: 2px;
  background: var(--bg-4);
  position: relative;
  transition: background .3s;
}

.flow-connector-line.done { background: var(--green); box-shadow: 0 0 6px var(--green-glow); }
.flow-connector-line.active { background: var(--blue); }

.flow-connector-arrow {
  width: 0; height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-left: 7px solid var(--bg-4);
  transition: border-left-color .3s;
}
.flow-connector-line.done + .flow-connector-arrow { border-left-color: var(--green); }
.flow-connector-line.active + .flow-connector-arrow { border-left-color: var(--blue); }

.flow-step-box {
  width: 110px;
  background: var(--bg-2);
  border: 1.5px solid var(--border-0);
  border-radius: var(--radius-md);
  padding: 10px;
  text-align: center;
  transition: all .25s;
  cursor: default;
  position: relative;
  overflow: hidden;
}

.flow-step-box::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--bg-4);
  transition: background .3s;
}

.flow-step-box.pending { border-color: var(--border-0); }
.flow-step-box.current {
  border-color: var(--blue);
  background: var(--blue-dim);
  box-shadow: 0 0 16px rgba(100,181,246,.2);
}
.flow-step-box.current::before { background: var(--blue); }
.flow-step-box.done {
  border-color: var(--border-green);
  background: var(--green-dim);
}
.flow-step-box.done::before { background: var(--green); box-shadow: 0 0 6px var(--green-glow); }
.flow-step-box.failed {
  border-color: rgba(255,95,95,.4);
  background: var(--red-dim);
}
.flow-step-box.failed::before { background: var(--red); }

.flow-step-icon {
  font-size: 1.2rem;
  margin-bottom: 4px;
}

.flow-step-name {
  font-size: .68rem;
  font-weight: 600;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.flow-step-type {
  font-size: .62rem;
  color: var(--text-2);
  font-family: var(--font-mono);
  margin-top: 2px;
}

.flow-step-status {
  margin-top: 6px;
}

/* ── SPINNING INDICATOR ── */
@keyframes spin {
  to { transform: rotate(360deg); }
}

.spinner {
  display: inline-block;
  width: 12px; height: 12px;
  border: 2px solid var(--bg-4);
  border-top-color: var(--blue);
  border-radius: 50%;
  animation: spin .8s linear infinite;
  vertical-align: middle;
}

/* ── PROGRESS BAR ── */
.progress-wrap {
  background: var(--bg-3);
  border-radius: 20px;
  height: 4px;
  overflow: hidden;
  margin: 12px 0;
}
.progress-bar {
  height: 100%;
  background: var(--green);
  border-radius: 20px;
  transition: width .6s ease;
  box-shadow: 0 0 8px var(--green-glow);
}

/* ── APPROVAL PANEL ── */
.approval-panel {
  background: var(--bg-2);
  border: 1px solid var(--blue-dim);
  border-radius: var(--radius-md);
  padding: 14px;
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.approval-info {
  flex: 1;
  font-size: .82rem;
  color: var(--text-0);
}

.approval-sub {
  font-size: .72rem;
  color: var(--text-2);
  font-family: var(--font-mono);
  margin-top: 2px;
}

/* ── LOG ENTRIES ── */
.log-entry {
  background: var(--bg-2);
  border: 1px solid var(--border-0);
  border-radius: var(--radius-md);
  margin-bottom: 6px;
  overflow: hidden;
  transition: border-color .18s;
}
.log-entry:hover { border-color: var(--border-1); }

.log-header {
  padding: 10px 14px;
  display: flex; align-items: center; gap: 10px;
  cursor: pointer;
  transition: .18s;
}
.log-header:hover { background: var(--bg-3); }

.log-step-num {
  width: 22px; height: 22px;
  border-radius: 4px;
  background: var(--bg-4);
  color: var(--green);
  font-size: .7rem; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-mono);
  flex-shrink: 0;
}

.log-step-title { font-weight: 600; font-size: .84rem; flex: 1; }
.log-body { padding: 0 14px 12px; display: none; }
.log-body.open { display: block; }

.log-json {
  background: var(--bg-0);
  border: 1px solid var(--border-0);
  border-radius: var(--radius-sm);
  padding: 10px;
  font-family: var(--font-mono);
  font-size: .72rem;
  white-space: pre-wrap;
  color: var(--text-1);
  max-height: 180px;
  overflow-y: auto;
  margin-top: 8px;
}

.rule-eval-row {
  display: flex; gap: 8px; align-items: center;
  font-size: .74rem; padding: 3px 0;
  font-family: var(--font-mono);
}

.rule-eval-cond { color: var(--text-1); flex: 1; }

.next-badge {
  display: inline-flex; align-items: center; gap: 5px;
  background: var(--green-dim);
  color: var(--green);
  padding: 3px 10px;
  border-radius: 4px;
  font-size: .72rem;
  font-weight: 600;
  margin-top: 6px;
  font-family: var(--font-mono);
  border: 1px solid var(--border-green);
}

/* ── SCHEMA ROWS ── */
.schema-field-row {
  display: grid;
  grid-template-columns: 1fr 80px 60px auto;
  gap: 8px; align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-0);
  font-size: .8rem;
}

/* ── ALLOWED VALUES ── */
.allowed-vals { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.allowed-tag {
  background: var(--green-dim);
  color: var(--green);
  border: 1px solid var(--border-green);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: .72rem;
  display: flex; align-items: center; gap: 4px;
  font-family: var(--font-mono);
}
.allowed-tag button {
  background: none; border: none; cursor: pointer;
  color: var(--green); font-size: .85rem; padding: 0; line-height: 1;
}

/* ── TOASTS ── */
.toast-container {
  position: fixed; bottom: 20px; right: 20px;
  z-index: 9999; display: flex; flex-direction: column; gap: 6px;
}
.toast {
  background: var(--bg-2);
  border-radius: var(--radius-md);
  padding: 10px 16px;
  box-shadow: var(--shadow-lg);
  font-size: .8rem;
  display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--border-1);
  animation: toastIn .2s ease;
  max-width: 300px;
  font-family: var(--font-mono);
}
.toast.success { border-left: 3px solid var(--green); }
.toast.error { border-left: 3px solid var(--red); }

@keyframes toastIn {
  from { transform: translateX(40px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

/* ── EMPTY STATES ── */
.empty-state {
  text-align: center;
  padding: 40px 24px;
  color: var(--text-2);
}
.empty-state .icon { font-size: 2rem; margin-bottom: 10px; opacity: .5; }
.empty-state .title {
  font-size: .9rem;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 4px;
}

/* ── BREADCRUMB ── */
.breadcrumb {
  display: flex; align-items: center; gap: 6px;
  font-size: .74rem;
  color: var(--text-2);
  font-family: var(--font-mono);
  margin-bottom: 4px;
}
.breadcrumb span {
  cursor: pointer;
  color: var(--green);
  font-weight: 500;
}
.breadcrumb span:hover { text-decoration: underline; }

/* ── MISC ── */
.divider { height: 1px; background: var(--border-0); margin: 12px 0; }
.flex { display: flex; }
.gap-2 { gap: 8px; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.mb-2 { margin-bottom: 8px; }
.mt-2 { margin-top: 8px; }
.text-muted { color: var(--text-2); font-size: .78rem; font-family: var(--font-mono); }

code {
  font-family: var(--font-mono);
  background: var(--bg-3);
  border: 1px solid var(--border-0);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: .8em;
  color: var(--green);
}

/* ── ENTER ANIMATIONS ── */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.page.active .card { animation: fadeUp .25s ease both; }
.page.active .card:nth-child(1) { animation-delay: 0s; }
.page.active .card:nth-child(2) { animation-delay: .05s; }
.page.active .card:nth-child(3) { animation-delay: .1s; }
.page.active .stat-card { animation: fadeUp .25s ease both; }
.page.active .stat-card:nth-child(1) { animation-delay: 0s; }
.page.active .stat-card:nth-child(2) { animation-delay: .05s; }
.page.active .stat-card:nth-child(3) { animation-delay: .1s; }
.page.active .stat-card:nth-child(4) { animation-delay: .15s; }
</style>
</head>
<body>

<!-- SIDEBAR -->
<aside class="sidebar">
  <div class="sidebar-logo">
    <div class="brand">
      <div class="brand-dot"></div>
      FlowCraft
    </div>
    <div class="tagline">workflow engine</div>
  </div>

  <div class="nav-section">Workspace</div>
  <div class="nav-item active" onclick="navigate('dashboard')">
    <span class="nav-icon">⬡</span> Dashboard
  </div>
  <div class="nav-item" onclick="navigate('workflows')">
    <span class="nav-icon">◈</span> Workflows
  </div>

  <div class="nav-section">Execution</div>
  <div class="nav-item" onclick="navigate('executions')">
    <span class="nav-icon">▷</span> Run Workflow
  </div>
  <div class="nav-item" onclick="navigate('audit')">
    <span class="nav-icon">▤</span> Audit Log
  </div>

  <div class="sidebar-footer">
    <div class="version-tag">v1.0.0</div>
    <div style="margin-top:4px;opacity:.6">MongoDB backend</div>
  </div>
</aside>

<!-- MAIN -->
<div class="main">
  <div class="topbar">
    <div class="topbar-title" id="page-title"><span>~/</span>dashboard</div>
    <div id="topbar-actions"></div>
  </div>

  <!-- DASHBOARD -->
  <div class="page active" id="page-dashboard">
    <div class="stats-row" id="stats-row">
      <div class="skeleton skel-stat"></div>
      <div class="skeleton skel-stat"></div>
      <div class="skeleton skel-stat"></div>
      <div class="skeleton skel-stat"></div>
    </div>
    <div class="card">
      <div class="card-title">Recent Executions</div>
      <div id="dashboard-recent">
        <div class="skeleton skel-row"></div>
        <div class="skeleton skel-row"></div>
        <div class="skeleton skel-row"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Quick Launch</div>
      <div id="quick-workflows" style="display:flex;gap:8px;flex-wrap:wrap;">
        <div class="skeleton" style="width:140px;height:32px;border-radius:6px;"></div>
        <div class="skeleton" style="width:160px;height:32px;border-radius:6px;"></div>
      </div>
    </div>
  </div>

  <!-- WORKFLOWS -->
  <div class="page" id="page-workflows">
    <div class="card">
      <div class="flex items-center justify-between mb-2">
        <div style="display:flex;gap:8px;flex:1;margin-right:12px;">
          <div class="input-wrap" style="max-width:280px;">
            <span class="icon">⌕</span>
            <input type="text" placeholder="Search workflows..." id="workflow-search" oninput="renderWorkflowList()">
          </div>
          <select class="form-input" style="width:130px;padding-left:10px;" id="workflow-filter" onchange="renderWorkflowList()">
            <option value="">All Status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="openWorkflowModal()">+ New Workflow</button>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Steps</th><th>Version</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody id="workflow-table-body">
            <tr><td colspan="6"><div class="skeleton skel-row" style="margin:4px 0;"></div></td></tr>
            <tr><td colspan="6"><div class="skeleton skel-row" style="margin:4px 0;"></div></td></tr>
          </tbody>
        </table>
      </div>
      <div id="workflow-empty" class="empty-state" style="display:none;">
        <div class="icon">◈</div>
        <div class="title">No workflows yet</div>
      </div>
    </div>
  </div>

  <!-- EDITOR -->
  <div class="page" id="page-editor">
    <div class="breadcrumb">
      <span onclick="navigate('workflows')">workflows</span>
      &rsaquo;
      <span id="editor-breadcrumb-name" style="color:var(--text-0);cursor:default;font-weight:600;"></span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 320px;gap:16px;">
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="card">
          <div class="card-title">Workflow Details</div>
          <div class="form-grid-2">
            <div class="form-row"><label class="form-label">Name</label><input type="text" class="form-input" id="wf-name"></div>
            <div class="form-row"><label class="form-label">Description</label><input type="text" class="form-input" id="wf-desc"></div>
          </div>
          <div class="form-row">
            <label class="form-label" style="display:flex;align-items:center;gap:8px;">
              Active <div class="toggle on" id="wf-active-toggle" onclick="this.classList.toggle('on')"></div>
            </label>
          </div>
          <div style="display:flex;justify-content:flex-end;">
            <button class="btn btn-ghost btn-sm" onclick="saveWorkflow()">Save Changes</button>
          </div>
        </div>
        <div class="card">
          <div class="flex items-center justify-between mb-2">
            <div class="card-title" style="margin-bottom:0;">Steps</div>
            <button class="btn btn-primary btn-sm" onclick="openStepModal()">+ Add Step</button>
          </div>
          <div id="steps-list"></div>
          <div id="steps-empty" class="empty-state" style="display:none;padding:28px;">
            <div class="icon">▤</div><div class="title">No steps yet</div>
          </div>
        </div>
      </div>
      <div class="card" style="height:fit-content;">
        <div class="flex items-center justify-between mb-2">
          <div class="card-title" style="margin-bottom:0;">Input Schema</div>
          <button class="btn btn-ghost btn-sm" onclick="openSchemaModal()">+ Field</button>
        </div>
        <div id="schema-list"></div>
        <div id="schema-empty" class="empty-state" style="display:none;padding:20px;">
          <div class="icon">⊞</div><div class="title">No fields</div>
        </div>
        <div class="divider"></div>
        <div class="text-muted">Types: <code>number</code> <code>string</code> <code>boolean</code></div>
      </div>
    </div>
  </div>

  <!-- RULES -->
  <div class="page" id="page-rules">
    <div class="breadcrumb">
      <span onclick="navigate('workflows')">workflows</span> &rsaquo;
      <span id="rule-wf-name" onclick="goBackToEditor()"></span> &rsaquo;
      <span style="color:var(--text-0);cursor:default;font-weight:600;" id="rule-step-name"></span>
    </div>
    <div class="card">
      <div class="flex items-center justify-between mb-2">
        <div>
          <div class="card-title" style="margin-bottom:4px;">Rule Editor</div>
          <p class="text-muted">Priority ordered. First match wins. DEFAULT catches unmatched cases.</p>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openRuleModal()">+ Add Rule</button>
      </div>
      <div id="rules-list"></div>
      <div id="rules-empty" class="empty-state" style="display:none;padding:28px;">
        <div class="icon">⊢</div><div class="title">No rules defined</div>
      </div>
      <div class="divider"></div>
      <div class="text-muted">
        Operators: <code>==</code> <code>!=</code> <code>&lt;</code> <code>&gt;</code>
        <code>&amp;&amp;</code> <code>||</code> <code>contains()</code> <code>startsWith()</code>
      </div>
    </div>
  </div>

  <!-- EXECUTIONS -->
  <div class="page" id="page-executions">
    <div class="card">
      <div class="card-title">Run Workflow</div>
      <div class="form-row">
        <label class="form-label">Select Workflow</label>
        <select class="form-input" id="exec-workflow-select" onchange="onExecWorkflowChange()">
          <option value="">Choose a workflow...</option>
        </select>
      </div>
      <div id="exec-input-fields"></div>
      <button class="btn btn-primary" id="exec-start-btn" onclick="startExecution()" style="display:none;margin-top:8px;">
        ▷ Run Execution
      </button>
    </div>
    <div id="exec-progress-card" style="display:none;">
      <div class="card">
        <div class="flex items-center justify-between mb-2">
          <div class="card-title" style="margin-bottom:0;">Execution Progress</div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="badge" id="exec-status-badge"></span>
            <button class="btn btn-ghost btn-sm" id="exec-cancel-btn" onclick="cancelExecution()">Cancel</button>
            <button class="btn btn-ghost btn-sm" id="exec-retry-btn" onclick="retryExecution()" style="display:none;">↻ Retry</button>
          </div>
        </div>
        <div class="text-muted mb-2" id="exec-meta" style="font-family:var(--font-mono);font-size:.72rem;"></div>
        <div class="progress-wrap"><div class="progress-bar" id="exec-progress-bar" style="width:0%"></div></div>
        <div style="margin-top:16px;" id="exec-steps-view"></div>
      </div>
      <div class="card" style="margin-top:14px;">
        <div class="card-title">Execution Logs</div>
        <div id="exec-logs-view"></div>
      </div>
    </div>
  </div>

  <!-- AUDIT -->
  <div class="page" id="page-audit">
    <div class="card">
      <div class="flex items-center justify-between mb-2">
        <div class="card-title" style="margin-bottom:0;">Audit Log</div>
        <div style="display:flex;gap:8px;">
          <div class="input-wrap" style="max-width:240px;">
            <span class="icon">⌕</span>
            <input type="text" placeholder="Search..." id="audit-search" oninput="renderAuditLog()">
          </div>
          <select class="form-input" style="width:140px;padding-left:10px;" id="audit-filter" onchange="renderAuditLog()">
            <option value="">All Statuses</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="canceled">Canceled</option>
            <option value="in_progress">In Progress</option>
          </select>
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr><th>ID</th><th>Workflow</th><th>Version</th><th>Status</th><th>Triggered By</th><th>Start</th><th>End</th><th>Actions</th></tr></thead>
          <tbody id="audit-table-body"></tbody>
        </table>
      </div>
      <div id="audit-empty" class="empty-state" style="display:none;">
        <div class="icon">▤</div><div class="title">No executions yet</div>
      </div>
    </div>
  </div>
</div>

<div class="toast-container" id="toast-container"></div>

<!-- MODALS -->
<div class="modal-overlay" id="modal-workflow">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title" id="wf-modal-title">Create Workflow</div>
      <button class="modal-close" onclick="closeModal('modal-workflow')">✕</button>
    </div>
    <div class="form-row"><label class="form-label">Name *</label><input type="text" class="form-input" id="modal-wf-name" placeholder="e.g. Expense Approval"></div>
    <div class="form-row"><label class="form-label">Description</label><input type="text" class="form-input" id="modal-wf-desc" placeholder="Optional description"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-workflow')">Cancel</button>
      <button class="btn btn-primary" onclick="saveWorkflowModal()">Create</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal-step">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title" id="step-modal-title">Add Step</div>
      <button class="modal-close" onclick="closeModal('modal-step')">✕</button>
    </div>
    <div class="form-row"><label class="form-label">Step Name *</label><input type="text" class="form-input" id="modal-step-name" placeholder="e.g. Manager Approval"></div>
    <div class="form-row"><label class="form-label">Step Type *</label>
      <select class="form-input" id="modal-step-type">
        <option value="task">Task</option>
        <option value="approval">Approval</option>
        <option value="notification">Notification</option>
      </select>
    </div>
    <div class="form-row"><label class="form-label">Assignee Email</label><input type="text" class="form-input" id="modal-step-assignee" placeholder="manager@example.com"></div>
    <div class="form-row"><label class="form-label">Instructions</label><textarea class="form-input" id="modal-step-instructions" rows="3" placeholder="Step instructions..."></textarea></div>
    <input type="hidden" id="modal-step-id">
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-step')">Cancel</button>
      <button class="btn btn-primary" onclick="saveStepModal()">Save Step</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal-rule">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title" id="rule-modal-title">Add Rule</div>
      <button class="modal-close" onclick="closeModal('modal-rule')">✕</button>
    </div>
    <div class="form-row">
      <label class="form-label">Priority *</label>
      <input type="number" class="form-input" id="modal-rule-priority" min="1" value="1">
      <div class="form-hint">Lower number = higher priority.</div>
    </div>
    <div class="form-row">
      <label class="form-label">Condition *</label>
      <input type="text" class="form-input" id="modal-rule-condition" placeholder="e.g. amount > 100 && country == 'US'  or  DEFAULT">
      <div class="form-hint">Use DEFAULT to catch unmatched cases.</div>
    </div>
    <div class="form-row">
      <label class="form-label">Next Step</label>
      <select class="form-input" id="modal-rule-next"><option value="">End Workflow</option></select>
    </div>
    <input type="hidden" id="modal-rule-id">
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-rule')">Cancel</button>
      <button class="btn btn-primary" onclick="saveRuleModal()">Save Rule</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal-schema">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title">Schema Field</div>
      <button class="modal-close" onclick="closeModal('modal-schema')">✕</button>
    </div>
    <div class="form-row"><label class="form-label">Field Name *</label><input type="text" class="form-input" id="modal-field-name" placeholder="e.g. amount"></div>
    <div class="form-row"><label class="form-label">Type *</label>
      <select class="form-input" id="modal-field-type">
        <option value="string">string</option>
        <option value="number">number</option>
        <option value="boolean">boolean</option>
      </select>
    </div>
    <div class="form-row">
      <label class="form-label" style="display:flex;align-items:center;gap:8px;">
        Required <div class="toggle on" id="field-required-toggle" onclick="this.classList.toggle('on')"></div>
      </label>
    </div>
    <div class="form-row">
      <label class="form-label">Allowed Values (optional)</label>
      <input type="text" class="form-input" id="modal-field-allowed-input" placeholder="Type value and press Enter" onkeydown="addAllowedVal(event)">
      <div class="allowed-vals" id="allowed-vals-container"></div>
    </div>
    <input type="hidden" id="modal-field-key">
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-schema')">Cancel</button>
      <button class="btn btn-primary" onclick="saveSchemaField()">Save Field</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal-exec-logs">
  <div class="modal" style="width:660px;max-width:97vw;">
    <div class="modal-header">
      <div class="modal-title" id="exec-logs-modal-title">Execution Logs</div>
      <button class="modal-close" onclick="closeModal('modal-exec-logs')">✕</button>
    </div>
    <div id="exec-logs-modal-body"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-exec-logs')">Close</button>
    </div>
  </div>
</div>

<script>
// ── ID REGISTRY (XSS-safe DOM building) ──
const _reg = {};
function reg(val) { const k = 'r' + Math.random().toString(36).slice(2); _reg[k] = val; return k; }
function get(k) { return _reg[k]; }

const API = {
  async req(method, path, body) {
    const opts = { method, headers: {'Content-Type':'application/json'} };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch('/api' + path, opts);
    if (!r.ok) { const e = await r.json().catch(() => ({error: r.statusText})); throw new Error(e.error || r.statusText); }
    return r.json();
  },
  get: p => API.req('GET', p),
  post: (p,b) => API.req('POST', p, b),
  put: (p,b) => API.req('PUT', p, b),
  del: p => API.req('DELETE', p),
};

let currentWorkflowId = null, currentStepId = null, currentExecId = null;
let allowedVals = [], wfStepsCache = [];

function eid(id) { return id ? String(id).substring(0,8)+'...' : '-'; }
function fmt(iso) { if (!iso) return '-'; try { return new Date(iso).toLocaleString(); } catch(e) { return iso; } }
function fmtShort(iso) { if (!iso) return '-'; try { const d = new Date(iso); return d.toLocaleDateString()+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); } catch(e) { return iso; } }
function dur(s,e) { if (!s||!e) return ''; const ms=new Date(e)-new Date(s),sec=Math.floor(ms/1000); return sec<60?sec+'s':Math.floor(sec/60)+'m '+sec%60+'s'; }
function esc(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function toast(msg, type='info') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const icons = { success: '✓', error: '✕', info: 'i' };
  t.innerHTML = '<span style="color:' + (type==='success'?'var(--green)':type==='error'?'var(--red)':'var(--text-1)') + '">' + (icons[type]||'i') + '</span><span>' + esc(msg) + '</span>';
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function toggleLog(id) { const el = document.getElementById(id); if(el) el.classList.toggle('open'); }

// Delegated event handling
document.addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const k = btn.dataset.k;
  const rid = k ? get(k) : btn.dataset.id;
  if (action === 'load-editor') loadEditor(rid);
  else if (action === 'quick-execute') quickExecute(rid);
  else if (action === 'delete-workflow') deleteWorkflow(rid);
  else if (action === 'open-rules') openRuleEditor(rid);
  else if (action === 'edit-step') openStepModal(rid);
  else if (action === 'delete-step') deleteStep(rid);
  else if (action === 'edit-rule') openRuleModal(rid);
  else if (action === 'delete-rule') deleteRule(rid);
  else if (action === 'edit-schema') openSchemaModal(rid);
  else if (action === 'delete-schema') deleteSchemaField(rid);
  else if (action === 'view-logs') viewExecLogs(rid);
});

function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const titles = { dashboard:'dashboard', workflows:'workflows', editor:'workflow editor', rules:'rule editor', executions:'run workflow', audit:'audit log' };
  const titleEl = document.getElementById('page-title');
  titleEl.innerHTML = '<span>~/</span>' + (titles[page] || page);
  const navMap = { dashboard:0, workflows:1, executions:2, audit:3 };
  const navItems = document.querySelectorAll('.nav-item');
  if (navMap[page] !== undefined) navItems[navMap[page]]?.classList.add('active');
  if (page === 'dashboard') renderDashboard();
  if (page === 'workflows') renderWorkflowList();
  if (page === 'executions') renderExecutionPage();
  if (page === 'audit') renderAuditLog();
}

function goBackToEditor() { navigate('editor'); loadEditor(currentWorkflowId); }

// ── DASHBOARD ──
async function renderDashboard() {
  try {
    const stats = await API.get('/stats');
    document.getElementById('stats-row').innerHTML =
      '<div class="stat-card"><div class="stat-label">Workflows</div><div class="stat-value">' + stats.workflows + '</div><div class="stat-sub">registered</div></div>' +
      '<div class="stat-card"><div class="stat-label">Executions</div><div class="stat-value">' + stats.executions + '</div><div class="stat-sub">all time</div></div>' +
      '<div class="stat-card"><div class="stat-label">Completed</div><div class="stat-value green">' + stats.completed + '</div><div class="stat-sub">finished</div></div>' +
      '<div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value ' + (stats.failed > 0 ? 'red' : '') + '">' + stats.failed + '</div><div class="stat-sub">require attention</div></div>';

    const [execRes, wfRes] = await Promise.all([API.get('/executions?limit=5'), API.get('/workflows')]);
    const wfMap = {}; (wfRes.data || []).forEach(w => wfMap[w.id||w._id] = w.name);
    const execs = execRes.data || [];
    const recentEl = document.getElementById('dashboard-recent');
    if (!execs.length) { recentEl.innerHTML = '<div class="text-muted" style="padding:16px 0;">No executions yet.</div>'; }
    else {
      recentEl.innerHTML = '<div style="overflow-x:auto;"><table><thead><tr><th>ID</th><th>Workflow</th><th>Status</th><th>Started</th><th>Duration</th></tr></thead><tbody>' +
        execs.map(e => '<tr><td class="uuid-cell">' + eid(e.id||e._id) + '</td><td style="font-weight:600;">' + esc(wfMap[e.workflow_id]||'-') + '</td><td><span class="badge badge-' + e.status + '">' + e.status.replace('_',' ') + '</span></td><td style="font-family:var(--font-mono);font-size:.75rem;">' + fmtShort(e.started_at) + '</td><td style="font-family:var(--font-mono);font-size:.75rem;">' + (dur(e.started_at, e.ended_at)||'-') + '</td></tr>').join('') +
        '</tbody></table></div>';
    }

    const qwEl = document.getElementById('quick-workflows');
    const active = (wfRes.data || []).filter(w => w.is_active).slice(0, 5);
    if (!active.length) { qwEl.innerHTML = '<div class="text-muted">No active workflows.</div>'; return; }
    qwEl.innerHTML = '';
    active.forEach(w => {
      const id = w.id || w._id;
      const k = reg(id);
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-sm';
      btn.innerHTML = '▷ ' + esc(w.name);
      btn.dataset.action = 'quick-execute';
      btn.dataset.k = k;
      qwEl.appendChild(btn);
    });
  } catch(e) { toast('Dashboard error: ' + e.message, 'error'); }
}

// ── WORKFLOWS ──
async function renderWorkflowList() {
  const search = document.getElementById('workflow-search')?.value || '';
  const status = document.getElementById('workflow-filter')?.value || '';
  try {
    const res = await API.get('/workflows?search=' + encodeURIComponent(search) + '&status=' + status);
    const list = res.data || [];
    const tbody = document.getElementById('workflow-table-body');
    const empty = document.getElementById('workflow-empty');
    if (!list.length) { tbody.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    tbody.innerHTML = '';
    list.forEach(wf => {
      const id = wf.id || wf._id;
      const k1 = reg(id), k2 = reg(id), k3 = reg(id);
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="uuid-cell" title="' + esc(id) + '">' + eid(id) + '</td>' +
        '<td><span style="font-weight:600;">' + esc(wf.name) + '</span>' + (wf.description ? '<div class="text-muted" style="margin-top:2px;">' + esc(wf.description) + '</div>' : '') + '</td>' +
        '<td style="font-family:var(--font-mono);">' + (wf.step_count || 0) + '</td>' +
        '<td style="font-family:var(--font-mono);color:var(--text-2);">v' + wf.version + '</td>' +
        '<td><span class="badge badge-' + (wf.is_active ? 'active' : 'inactive') + '">' + (wf.is_active ? 'active' : 'inactive') + '</span></td>' +
        '<td><div class="actions-cell">' +
          '<button class="btn btn-ghost btn-xs" data-action="load-editor" data-k="' + k1 + '">Edit</button>' +
          '<button class="btn btn-primary btn-xs" data-action="quick-execute" data-k="' + k2 + '">Run</button>' +
          '<button class="btn btn-danger btn-xs" data-action="delete-workflow" data-k="' + k3 + '">Del</button>' +
        '</div></td>';
      tbody.appendChild(tr);
    });
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

function openWorkflowModal(id) {
  document.getElementById('modal-wf-name').value = '';
  document.getElementById('modal-wf-desc').value = '';
  document.getElementById('modal-wf-name').dataset.editId = id || '';
  document.getElementById('wf-modal-title').textContent = id ? 'Edit Workflow' : 'Create Workflow';
  openModal('modal-workflow');
}

async function saveWorkflowModal() {
  const name = document.getElementById('modal-wf-name').value.trim();
  if (!name) { toast('Name required', 'error'); return; }
  const editId = document.getElementById('modal-wf-name').dataset.editId;
  try {
    if (editId) await API.put('/workflows/' + editId, { name, description: document.getElementById('modal-wf-desc').value.trim() });
    else await API.post('/workflows', { name, description: document.getElementById('modal-wf-desc').value.trim() });
    toast('Saved', 'success'); closeModal('modal-workflow'); renderWorkflowList();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteWorkflow(id) {
  if (!confirm('Delete this workflow and all its steps/rules?')) return;
  try { await API.del('/workflows/' + id); toast('Deleted', 'success'); renderWorkflowList(); } catch(e) { toast(e.message, 'error'); }
}

async function saveWorkflow() {
  if (!currentWorkflowId) return;
  try {
    const wf = await API.put('/workflows/' + currentWorkflowId, {
      name: document.getElementById('wf-name').value.trim(),
      description: document.getElementById('wf-desc').value.trim(),
      is_active: document.getElementById('wf-active-toggle').classList.contains('on'),
    });
    document.getElementById('editor-breadcrumb-name').textContent = wf.name;
    toast('Saved', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function loadEditor(id) {
  currentWorkflowId = id;
  try {
    const wf = await API.get('/workflows/' + id);
    document.getElementById('editor-breadcrumb-name').textContent = wf.name;
    document.getElementById('wf-name').value = wf.name;
    document.getElementById('wf-desc').value = wf.description || '';
    document.getElementById('wf-active-toggle').classList.toggle('on', wf.is_active);
    navigate('editor');
    renderStepsList(wf.steps || []);
    renderSchemaList(wf.input_schema || {});
  } catch(e) { toast(e.message, 'error'); }
}

// ── SCHEMA ──
function openSchemaModal(key) {
  allowedVals = [];
  document.getElementById('modal-field-name').value = key || '';
  document.getElementById('modal-field-type').value = 'string';
  document.getElementById('field-required-toggle').classList.add('on');
  document.getElementById('modal-field-allowed-input').value = '';
  document.getElementById('allowed-vals-container').innerHTML = '';
  document.getElementById('modal-field-key').value = key || '';
  if (key) {
    API.get('/workflows/' + currentWorkflowId).then(wf => {
      const f = wf.input_schema[key]; if (!f) return;
      document.getElementById('modal-field-type').value = f.type;
      document.getElementById('field-required-toggle').classList.toggle('on', f.required);
      if (f.allowed_values) { allowedVals = [...f.allowed_values]; renderAllowedVals(); }
    });
  }
  openModal('modal-schema');
}

function addAllowedVal(e) {
  if (e.key !== 'Enter') return; e.preventDefault();
  const v = document.getElementById('modal-field-allowed-input').value.trim();
  if (v && !allowedVals.includes(v)) { allowedVals.push(v); renderAllowedVals(); }
  document.getElementById('modal-field-allowed-input').value = '';
}

function renderAllowedVals() {
  const c = document.getElementById('allowed-vals-container'); c.innerHTML = '';
  allowedVals.forEach((v, i) => {
    const span = document.createElement('span'); span.className = 'allowed-tag';
    span.textContent = v;
    const btn = document.createElement('button'); btn.textContent = '×';
    btn.onclick = () => { allowedVals.splice(i, 1); renderAllowedVals(); };
    span.appendChild(btn); c.appendChild(span);
  });
}

async function saveSchemaField() {
  const name = document.getElementById('modal-field-name').value.trim();
  if (!name) { toast('Field name required', 'error'); return; }
  try {
    const wf = await API.get('/workflows/' + currentWorkflowId);
    const schema = { ...(wf.input_schema || {}) };
    const oldKey = document.getElementById('modal-field-key').value;
    if (oldKey && oldKey !== name) delete schema[oldKey];
    schema[name] = {
      type: document.getElementById('modal-field-type').value,
      required: document.getElementById('field-required-toggle').classList.contains('on'),
      ...(allowedVals.length ? { allowed_values: [...allowedVals] } : {})
    };
    await API.put('/workflows/' + currentWorkflowId, { input_schema: schema });
    closeModal('modal-schema'); renderSchemaList(schema); toast('Field saved', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteSchemaField(key) {
  try {
    const wf = await API.get('/workflows/' + currentWorkflowId);
    const schema = { ...(wf.input_schema || {}) }; delete schema[key];
    await API.put('/workflows/' + currentWorkflowId, { input_schema: schema });
    renderSchemaList(schema);
  } catch(e) { toast(e.message, 'error'); }
}

function renderSchemaList(schema) {
  const keys = Object.keys(schema || {});
  const el = document.getElementById('schema-list');
  const empty = document.getElementById('schema-empty');
  if (!keys.length) { el.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  el.innerHTML = '';
  keys.forEach(k => {
    const f = schema[k];
    const row = document.createElement('div');
    row.className = 'schema-field-row';
    const k1 = reg(k), k2 = reg(k);
    row.innerHTML =
      '<span style="font-weight:600;font-family:var(--font-mono);font-size:.8rem;color:var(--text-0);">' + esc(k) + '</span>' +
      '<span class="badge" style="font-size:.68rem;background:var(--bg-3);color:var(--text-2);border:1px solid var(--border-0);">' + esc(f.type) + '</span>' +
      '<span class="badge badge-' + (f.required ? 'active' : 'inactive') + '" style="font-size:.65rem;">' + (f.required ? 'req' : 'opt') + '</span>' +
      '<div style="display:flex;gap:3px;">' +
        '<button class="btn btn-ghost btn-xs" data-action="edit-schema" data-k="' + k1 + '">Edit</button>' +
        '<button class="btn btn-danger btn-xs" data-action="delete-schema" data-k="' + k2 + '">Del</button>' +
      '</div>';
    el.appendChild(row);
    if (f.allowed_values) {
      const av = document.createElement('div');
      av.style.gridColumn = '1/-1'; av.style.paddingBottom = '4px';
      const wrap = document.createElement('div'); wrap.className = 'allowed-vals';
      f.allowed_values.forEach(v => { const s = document.createElement('span'); s.className = 'allowed-tag'; s.textContent = v; wrap.appendChild(s); });
      av.appendChild(wrap); el.appendChild(av);
    }
  });
}

// ── STEPS ──
function openStepModal(id) {
  document.getElementById('modal-step-name').value = '';
  document.getElementById('modal-step-type').value = 'task';
  document.getElementById('modal-step-assignee').value = '';
  document.getElementById('modal-step-instructions').value = '';
  document.getElementById('modal-step-id').value = id || '';
  document.getElementById('step-modal-title').textContent = id ? 'Edit Step' : 'Add Step';
  if (id) {
    const s = wfStepsCache.find(s => (s.id||s._id) === id);
    if (s) {
      document.getElementById('modal-step-name').value = s.name;
      document.getElementById('modal-step-type').value = s.step_type;
      document.getElementById('modal-step-assignee').value = s.metadata?.assignee_email || '';
      document.getElementById('modal-step-instructions').value = s.metadata?.instructions || '';
    }
  }
  openModal('modal-step');
}

async function saveStepModal() {
  const name = document.getElementById('modal-step-name').value.trim();
  if (!name) { toast('Step name required', 'error'); return; }
  const editId = document.getElementById('modal-step-id').value;
  const body = { name, step_type: document.getElementById('modal-step-type').value, metadata: { assignee_email: document.getElementById('modal-step-assignee').value.trim(), instructions: document.getElementById('modal-step-instructions').value.trim() } };
  try {
    if (editId) await API.put('/steps/' + editId, body);
    else await API.post('/workflows/' + currentWorkflowId + '/steps', body);
    toast(editId ? 'Step updated' : 'Step added', 'success');
    closeModal('modal-step');
    const steps = await API.get('/workflows/' + currentWorkflowId + '/steps');
    renderStepsList(steps);
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteStep(id) {
  if (!confirm('Delete this step and its rules?')) return;
  try {
    await API.del('/steps/' + id);
    const steps = await API.get('/workflows/' + currentWorkflowId + '/steps');
    renderStepsList(steps); toast('Step deleted', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

function renderStepsList(steps) {
  wfStepsCache = steps;
  const el = document.getElementById('steps-list');
  const empty = document.getElementById('steps-empty');
  if (!steps.length) { el.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  el.innerHTML = '';
  steps.forEach(s => {
    const id = s.id || s._id;
    const k1 = reg(id), k2 = reg(id), k3 = reg(id);
    const typeIcons = { task: '⚙', approval: '✋', notification: '🔔' };
    const card = document.createElement('div'); card.className = 'step-card';
    card.innerHTML =
      '<div class="step-order">' + s.order + '</div>' +
      '<div class="step-info">' +
        '<div class="step-name">' + (typeIcons[s.step_type]||'') + ' ' + esc(s.name) + '</div>' +
        '<div style="margin-top:3px;"><span class="badge badge-' + s.step_type + '">' + s.step_type + '</span>' + (s.metadata?.assignee_email ? '<span style="font-size:.72rem;color:var(--text-2);font-family:var(--font-mono);margin-left:8px;">' + esc(s.metadata.assignee_email) + '</span>' : '') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:5px;">' +
        '<button class="btn btn-ghost btn-xs" data-action="open-rules" data-k="' + k1 + '">Rules</button>' +
        '<button class="btn btn-ghost btn-xs" data-action="edit-step" data-k="' + k2 + '">Edit</button>' +
        '<button class="btn btn-danger btn-xs" data-action="delete-step" data-k="' + k3 + '">Del</button>' +
      '</div>';
    el.appendChild(card);
  });
}

// ── RULES ──
async function openRuleEditor(stepId) {
  currentStepId = stepId;
  const step = wfStepsCache.find(s => (s.id||s._id) === stepId);
  const wf = await API.get('/workflows/' + currentWorkflowId);
  document.getElementById('rule-wf-name').textContent = wf.name;
  document.getElementById('rule-step-name').textContent = step?.name || stepId;
  navigate('rules');
  renderRulesList();
}

async function openRuleModal(id) {
  document.getElementById('modal-rule-id').value = id || '';
  document.getElementById('modal-rule-priority').value = '1';
  document.getElementById('modal-rule-condition').value = '';
  document.getElementById('rule-modal-title').textContent = id ? 'Edit Rule' : 'Add Rule';
  const steps = wfStepsCache.length ? wfStepsCache : await API.get('/workflows/' + currentWorkflowId + '/steps');
  const sel = document.getElementById('modal-rule-next');
  sel.innerHTML = '<option value="">End Workflow</option>';
  steps.forEach(s => { const opt = document.createElement('option'); opt.value = s.id||s._id; opt.textContent = s.name; sel.appendChild(opt); });
  if (id) {
    const rules = await API.get('/steps/' + currentStepId + '/rules');
    const r = rules.find(r => (r.id||r._id) === id);
    if (r) { document.getElementById('modal-rule-priority').value = r.priority; document.getElementById('modal-rule-condition').value = r.condition; sel.value = r.next_step_id || ''; }
  }
  openModal('modal-rule');
}

async function saveRuleModal() {
  const condition = document.getElementById('modal-rule-condition').value.trim();
  if (!condition) { toast('Condition required', 'error'); return; }
  const editId = document.getElementById('modal-rule-id').value;
  const body = { condition, priority: parseInt(document.getElementById('modal-rule-priority').value) || 1, next_step_id: document.getElementById('modal-rule-next').value || null };
  try {
    if (editId) await API.put('/rules/' + editId, body);
    else await API.post('/steps/' + currentStepId + '/rules', body);
    toast('Rule saved', 'success'); closeModal('modal-rule'); renderRulesList();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteRule(id) {
  try { await API.del('/rules/' + id); renderRulesList(); toast('Rule deleted'); } catch(e) { toast(e.message, 'error'); }
}

async function renderRulesList() {
  try {
    const rules = await API.get('/steps/' + currentStepId + '/rules');
    const steps = wfStepsCache.length ? wfStepsCache : await API.get('/workflows/' + currentWorkflowId + '/steps');
    const stepMap = {}; steps.forEach(s => stepMap[s.id||s._id] = s.name);
    const el = document.getElementById('rules-list');
    const empty = document.getElementById('rules-empty');
    if (!rules.length) { el.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    el.innerHTML = '';
    rules.forEach(r => {
      const id = r.id || r._id;
      const k1 = reg(id), k2 = reg(id);
      const isDefault = r.condition.trim().toUpperCase() === 'DEFAULT';
      const next = r.next_step_id ? (stepMap[r.next_step_id] || r.next_step_id) : 'End Workflow';
      const row = document.createElement('div'); row.className = 'rule-row';
      row.innerHTML =
        '<div class="rule-priority">' + r.priority + '</div>' +
        '<div class="rule-condition' + (isDefault ? ' default' : '') + '">' + esc(r.condition) + '</div>' +
        '<div style="font-size:.75rem;color:var(--text-1);font-family:var(--font-mono);font-weight:500;">→ ' + esc(next) + '</div>' +
        '<div style="display:flex;gap:3px;">' +
          '<button class="btn btn-ghost btn-xs" data-action="edit-rule" data-k="' + k1 + '">Edit</button>' +
          '<button class="btn btn-danger btn-xs" data-action="delete-rule" data-k="' + k2 + '">Del</button>' +
        '</div>';
      el.appendChild(row);
    });
  } catch(e) { toast(e.message, 'error'); }
}

// ── EXECUTIONS ──
async function renderExecutionPage() {
  try {
    const res = await API.get('/workflows?status=true&limit=100');
    const sel = document.getElementById('exec-workflow-select');
    sel.innerHTML = '<option value="">Choose a workflow...</option>';
    (res.data || []).forEach(w => { const opt = document.createElement('option'); opt.value = w.id||w._id; opt.textContent = w.name; sel.appendChild(opt); });
    document.getElementById('exec-input-fields').innerHTML = '';
    document.getElementById('exec-start-btn').style.display = 'none';
    document.getElementById('exec-progress-card').style.display = 'none';
    const execRes = await API.get('/executions?status=in_progress&limit=1');
    const active = (execRes.data || [])[0];
    if (active) {
      currentExecId = active.id || active._id;
      currentWorkflowId = active.workflow_id;
      sel.value = active.workflow_id;
      const wf = await API.get('/workflows/' + active.workflow_id);
      document.getElementById('exec-progress-card').style.display = '';
      document.getElementById('exec-start-btn').style.display = 'none';
      document.getElementById('exec-input-fields').innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--blue-dim);border-radius:8px;margin-top:8px;border:1px solid rgba(100,181,246,.2);">' +
        '<span style="font-size:.8rem;font-weight:600;color:var(--blue);font-family:var(--font-mono);">↻ Resuming in-progress execution</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="resetExecution()">+ New</button></div>';
      renderExecView(active, wf);
      toast('Resumed in-progress execution', 'success');
    }
  } catch(e) { toast(e.message, 'error'); }
}

async function onExecWorkflowChange() {
  const id = document.getElementById('exec-workflow-select').value;
  document.getElementById('exec-start-btn').style.display = 'none';
  document.getElementById('exec-progress-card').style.display = 'none';
  if (!id) { document.getElementById('exec-input-fields').innerHTML = ''; return; }
  try {
    const wf = await API.get('/workflows/' + id);
    const schema = wf.input_schema || {};
    const fields = Object.keys(schema);
    const container = document.getElementById('exec-input-fields');
    container.innerHTML = '';
    if (fields.length) {
      const div = document.createElement('div'); div.className = 'divider'; container.appendChild(div);
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-weight:700;font-size:.72rem;margin-bottom:10px;color:var(--text-2);font-family:var(--font-mono);letter-spacing:1.5px;text-transform:uppercase;';
      lbl.textContent = 'Input Data';
      container.appendChild(lbl);
      fields.forEach(k => {
        const f = schema[k];
        const row = document.createElement('div'); row.className = 'form-row';
        const label = document.createElement('label'); label.className = 'form-label';
        label.textContent = k + ' (' + f.type + (f.required ? ', required' : '') + ')';
        row.appendChild(label);
        let inp;
        if (f.allowed_values?.length) {
          inp = document.createElement('select'); inp.className = 'form-input';
          const def = document.createElement('option'); def.value = ''; def.textContent = 'Select...'; inp.appendChild(def);
          f.allowed_values.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; inp.appendChild(o); });
        } else if (f.type === 'boolean') {
          inp = document.createElement('select'); inp.className = 'form-input';
          ['true', 'false'].forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; inp.appendChild(o); });
        } else {
          inp = document.createElement('input');
          inp.type = f.type === 'number' ? 'number' : 'text';
          inp.className = 'form-input';
          inp.placeholder = f.required ? 'Required' : 'Optional';
        }
        inp.id = 'exec-field-' + k;
        row.appendChild(inp);
        container.appendChild(row);
      });
    }
    document.getElementById('exec-start-btn').style.display = '';
  } catch(e) { toast(e.message, 'error'); }
}

async function startExecution() {
  const wfId = document.getElementById('exec-workflow-select').value;
  if (!wfId) { toast('Select a workflow', 'error'); return; }
  try {
    const wf = await API.get('/workflows/' + wfId);
    const data = {};
    for (const k of Object.keys(wf.input_schema || {})) {
      const el = document.getElementById('exec-field-' + k); if (!el) continue;
      const v = el.value.trim(); const f = wf.input_schema[k];
      if (f.required && !v) { toast('Field "' + k + '" is required', 'error'); return; }
      if (f.type === 'number') data[k] = v ? parseFloat(v) : null;
      else if (f.type === 'boolean') data[k] = v === 'true';
      else data[k] = v;
    }
    const exec = await API.post('/workflows/' + wfId + '/execute', { data, triggered_by: 'user-ui' });
    currentExecId = exec.id || exec._id;
    toast('Execution started', 'success');
    document.getElementById('exec-progress-card').style.display = '';
    renderExecView(exec, wf);
  } catch(e) { toast(e.message, 'error'); }
}

async function cancelExecution() {
  if (!currentExecId) return;
  try { const exec = await API.post('/executions/' + currentExecId + '/cancel'); const wf = await API.get('/workflows/' + exec.workflow_id); renderExecView(exec, wf); toast('Canceled'); } catch(e) { toast(e.message, 'error'); }
}

async function retryExecution() {
  if (!currentExecId) return;
  try { const exec = await API.post('/executions/' + currentExecId + '/retry'); const wf = await API.get('/workflows/' + exec.workflow_id); renderExecView(exec, wf); toast('Retrying...', 'success'); } catch(e) { toast(e.message, 'error'); }
}

function _doApprove(dec) { approveStep(dec); }

async function approveStep(decision) {
  if (!currentExecId) return;
  try {
    const exec = await API.post('/executions/' + currentExecId + '/approve', { decision, approver_id: 'user-ui' });
    const fresh = await API.get('/executions/' + currentExecId);
    const wf = await API.get('/workflows/' + exec.workflow_id);
    renderExecView(fresh, wf);
    toast(decision === 'approve' ? '✓ Approved' : '✕ Rejected', decision === 'approve' ? 'success' : 'error');
  } catch(e) { toast(e.message, 'error'); }
}

// ── FLOW DIAGRAM RENDERER ──
async function renderExecView(exec, wf) {
  const statusBadge = document.getElementById('exec-status-badge');
  statusBadge.textContent = exec.status.replace('_', ' ').toUpperCase();
  statusBadge.className = 'badge badge-' + exec.status;

  document.getElementById('exec-meta').textContent =
    wf.name + ' · v' + exec.workflow_version + ' · started ' + fmtShort(exec.started_at) +
    (exec.ended_at ? ' · ended ' + fmtShort(exec.ended_at) : '') +
    (exec.retries ? ' · ' + exec.retries + ' retries' : '');

  document.getElementById('exec-retry-btn').style.display = exec.status === 'failed' ? '' : 'none';
  document.getElementById('exec-cancel-btn').style.display = exec.status === 'in_progress' ? '' : 'none';

  const steps = wf.steps || await API.get('/workflows/' + (wf._id||wf.id) + '/steps').catch(() => []);
  const done = exec.logs.filter(l => l.status === 'completed').length;
  document.getElementById('exec-progress-bar').style.width = steps.length ? Math.round(done / steps.length * 100) + '%' : '0%';

  // ── FLOW DIAGRAM ──
  const sv = document.getElementById('exec-steps-view');
  sv.innerHTML = '';

  const flowWrap = document.createElement('div');
  flowWrap.className = 'flow-diagram';

  steps.forEach((s, idx) => {
    const sid = s.id || s._id;
    const log = exec.logs.find(l => l.step_id === sid);
    const isCurrent = exec.current_step_id === sid;
    let state = 'pending';
    if (log) state = log.status === 'completed' ? 'done' : 'failed';
    if (isCurrent && exec.status === 'in_progress') state = 'current';

    const typeIcons = { task: '⚙', approval: '✋', notification: '🔔' };
    const stateIcons = { pending: '○', current: '↻', done: '✓', failed: '✕' };

    // Node
    const node = document.createElement('div');
    node.className = 'flow-node';

    const box = document.createElement('div');
    box.className = 'flow-step-box ' + state;
    box.innerHTML =
      '<div class="flow-step-icon">' + (typeIcons[s.step_type] || '⚙') + '</div>' +
      '<div class="flow-step-name" title="' + esc(s.name) + '">' + esc(s.name) + '</div>' +
      '<div class="flow-step-type">' + s.step_type + '</div>' +
      '<div class="flow-step-status">' +
        (state === 'current' ? '<span class="spinner"></span>' : '<span class="badge badge-' + (log ? log.status : (isCurrent ? 'in_progress' : 'pending')) + '" style="font-size:.62rem;padding:1px 5px;">' + (state === 'done' ? '✓' : state === 'failed' ? '✕' : '…') + '</span>') +
      '</div>';
    node.appendChild(box);

    // Approval action panel below node
    if (isCurrent && exec.status === 'in_progress' && s.step_type === 'approval') {
      const apanel = document.createElement('div');
      apanel.style.cssText = 'margin-top:8px;width:110px;';
      apanel.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:4px;">' +
          '<button class="btn btn-primary btn-xs" data-dec="approve" onclick="_doApprove(this.dataset.dec)" style="width:100%;justify-content:center;">Approve</button>' +
          '<button class="btn btn-danger btn-xs" data-dec="reject" onclick="_doApprove(this.dataset.dec)" style="width:100%;justify-content:center;">Reject</button>' +
        '</div>';
      node.appendChild(apanel);
    }

    flowWrap.appendChild(node);

    // Connector between nodes
    if (idx < steps.length - 1) {
      const connState = log && log.status === 'completed' ? 'done' : (isCurrent ? 'active' : '');
      const conn = document.createElement('div');
      conn.className = 'flow-connector';
      conn.innerHTML = '<div class="flow-connector-line ' + connState + '"></div><div class="flow-connector-arrow' + (connState ? ' ' + connState : '') + '"></div>';
      flowWrap.appendChild(conn);
    }
  });

  sv.appendChild(flowWrap);

  // Approval panel (full-width, below diagram) for current approval step
  const currentStep = steps.find(s => (s.id||s._id) === exec.current_step_id);
  if (currentStep && currentStep.step_type === 'approval' && exec.status === 'in_progress') {
    const panel = document.createElement('div');
    panel.className = 'approval-panel';
    panel.innerHTML =
      '<div class="approval-info">' +
        '<div>⏳ Awaiting approval — <strong>' + esc(currentStep.name) + '</strong></div>' +
        (currentStep.metadata?.assignee_email ? '<div class="approval-sub">Assignee: ' + esc(currentStep.metadata.assignee_email) + '</div>' : '') +
        (currentStep.metadata?.instructions ? '<div class="approval-sub" style="margin-top:4px;">' + esc(currentStep.metadata.instructions) + '</div>' : '') +
      '</div>' +
      '<button class="btn btn-primary btn-sm" data-dec="approve" onclick="_doApprove(this.dataset.dec)">✓ Approve</button>' +
      '<button class="btn btn-danger btn-sm" data-dec="reject" onclick="_doApprove(this.dataset.dec)">✕ Reject</button>';
    sv.appendChild(panel);
  }

  // ── LOGS ──
  const lv = document.getElementById('exec-logs-view');
  if (!exec.logs.length) { lv.innerHTML = '<div class="text-muted" style="padding:12px 0;">No logs yet.</div>'; return; }
  lv.innerHTML = '';
  exec.logs.forEach((l, i) => {
    const entry = document.createElement('div'); entry.className = 'log-entry';
    const lid = 'lb-' + i + '-' + Date.now();
    entry.innerHTML =
      '<div class="log-header" data-lid="' + lid + '" onclick="toggleLog(this.dataset.lid)">' +
        '<div class="log-step-num">' + (i+1) + '</div>' +
        '<div class="log-step-title">' + esc(l.step_name) + '</div>' +
        '<span class="badge badge-' + l.status + '">' + l.status + '</span>' +
        '<div style="font-size:.7rem;color:var(--text-2);font-family:var(--font-mono);">' + (dur(l.started_at, l.ended_at) || '') + '</div>' +
      '</div>' +
      '<div class="log-body" id="' + lid + '">' +
        (l.evaluated_rules?.length ?
          '<div style="margin-bottom:6px;font-weight:600;font-size:.74rem;color:var(--text-2);font-family:var(--font-mono);letter-spacing:1px;text-transform:uppercase;">Rules Evaluated</div>' +
          l.evaluated_rules.map(r =>
            '<div class="rule-eval-row">' +
              '<span style="color:' + (r.result ? 'var(--green)' : 'var(--red)') + ';font-weight:700;">' + (r.result ? '✓' : '✕') + '</span>' +
              '<span class="rule-eval-cond">' + esc(r.rule) + '</span>' +
              '<span style="color:' + (r.result ? 'var(--green)' : 'var(--text-2)') + ';font-weight:600;">' + (r.result ? 'MATCH' : 'skip') + '</span>' +
            '</div>'
          ).join('') : '') +
        (l.selected_next_step ? '<div class="next-badge">→ ' + esc(l.selected_next_step) + '</div>' : '') +
        (l.approver_id ? '<div style="margin-top:6px;font-size:.72rem;color:var(--text-2);font-family:var(--font-mono);">Approver: ' + esc(l.approver_id) + '</div>' : '') +
        (l.error_message ? '<div style="margin-top:6px;font-size:.72rem;color:var(--red);font-family:var(--font-mono);">✕ ' + esc(l.error_message) + '</div>' : '') +
        '<div class="log-json">' + esc(JSON.stringify(l, null, 2)) + '</div>' +
      '</div>';
    lv.appendChild(entry);
  });
}

function resetExecution() {
  currentExecId = null;
  document.getElementById('exec-progress-card').style.display = 'none';
  document.getElementById('exec-input-fields').innerHTML = '';
  document.getElementById('exec-start-btn').style.display = 'none';
  document.getElementById('exec-workflow-select').value = '';
  toast('Ready for new execution');
}

function quickExecute(id) {
  currentWorkflowId = id;
  navigate('executions');
  document.getElementById('exec-workflow-select').value = id;
  onExecWorkflowChange();
}

// ── AUDIT LOG ──
async function renderAuditLog() {
  const search = document.getElementById('audit-search')?.value || '';
  const status = document.getElementById('audit-filter')?.value || '';
  try {
    const [execRes, wfRes] = await Promise.all([
      API.get('/executions?search=' + encodeURIComponent(search) + '&status=' + status),
      API.get('/workflows?limit=200')
    ]);
    const wfMap = {}; (wfRes.data || []).forEach(w => wfMap[w.id||w._id] = w.name);
    const list = execRes.data || [];
    const tbody = document.getElementById('audit-table-body');
    const empty = document.getElementById('audit-empty');
    if (!list.length) { tbody.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    tbody.innerHTML = '';
    list.forEach(e => {
      const id = e.id || e._id;
      const k = reg(id);
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="uuid-cell" title="' + esc(id) + '">' + eid(id) + '</td>' +
        '<td style="font-weight:600;">' + esc(wfMap[e.workflow_id] || '-') + '</td>' +
        '<td style="font-family:var(--font-mono);color:var(--text-2);">v' + e.workflow_version + '</td>' +
        '<td><span class="badge badge-' + e.status + '">' + e.status.replace('_', ' ').toUpperCase() + '</span></td>' +
        '<td style="font-family:var(--font-mono);font-size:.76rem;color:var(--text-2);">' + esc(e.triggered_by || '-') + '</td>' +
        '<td style="font-family:var(--font-mono);font-size:.76rem;">' + fmtShort(e.started_at) + '</td>' +
        '<td style="font-family:var(--font-mono);font-size:.76rem;">' + fmtShort(e.ended_at) + '</td>' +
        '<td><button class="btn btn-ghost btn-xs" data-action="view-logs" data-k="' + k + '">Logs</button></td>';
      tbody.appendChild(tr);
    });
  } catch(e) { toast(e.message, 'error'); }
}

async function viewExecLogs(id) {
  try {
    const exec = await API.get('/executions/' + id);
    const wf = await API.get('/workflows/' + exec.workflow_id).catch(() => ({ name: '-' }));
    document.getElementById('exec-logs-modal-title').textContent = 'Logs — ' + wf.name;
    const body = document.getElementById('exec-logs-modal-body'); body.innerHTML = '';
    if (!exec.logs.length) { body.innerHTML = '<div class="text-muted">No logs.</div>'; openModal('modal-exec-logs'); return; }
    exec.logs.forEach((l, i) => {
      const lid = 'ml-' + i + '-' + Date.now();
      const entry = document.createElement('div'); entry.className = 'log-entry';
      entry.innerHTML =
        '<div class="log-header" data-lid="' + lid + '" onclick="toggleLog(this.dataset.lid)">' +
          '<div class="log-step-num">' + (i+1) + '</div>' +
          '<div class="log-step-title">' + esc(l.step_name) + '</div>' +
          '<span class="badge badge-' + l.status + '">' + l.status + '</span>' +
        '</div>' +
        '<div class="log-body" id="' + lid + '"><div class="log-json">' + esc(JSON.stringify(l, null, 2)) + '</div></div>';
      body.appendChild(entry);
    });
    openModal('modal-exec-logs');
  } catch(e) { toast(e.message, 'error'); }
}

navigate('dashboard');
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(FRONTEND_HTML));

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB connected:', MONGO_URI);
    await seedSampleData();
    app.listen(PORT, () => {
      console.log('🚀 FlowCraft running at http://localhost:' + PORT);
      console.log('   MongoDB URI:', MONGO_URI);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });