// Minimal emergency persistence using Mongoose
const mongoose = require('mongoose');

const EmergencySchema = new mongoose.Schema(
  {
    homeId: { type: String, index: true, required: true },
    deviceId: { type: String, index: true, required: true }, // from | deviceId
    type: { type: String, index: true, required: true },     // STOVE_EMERGENCY, CO_DANGER, CONTROL_DENIED, etc.
    severity: { type: String, enum: ['info', 'warn', 'danger'], default: 'warn', index: true },
    detail: { type: mongoose.Schema.Types.Mixed },            // arbitrary JSON (temp, co, reason, etc.)
    ts: { type: Date, default: Date.now, index: true },
    handled: { type: Boolean, default: false, index: true },
    handledBy: { type: String },                              // userId/email if acknowledged
    note: { type: String }, // new:
  acknowledged: { type: Boolean, default: false, index: true },
  acknowledgedAt: Date,
  acknowledgedBy: { type: String }, // user id/email
}, { timestamps: true });
EmergencySchema.index({ homeId: 1, ts: -1 });
EmergencySchema.index({ homeId: 1, type: 1, ts: -1 });


module.exports = mongoose.model('Emergency', EmergencySchema);
