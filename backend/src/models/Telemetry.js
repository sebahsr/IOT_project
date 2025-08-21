const mongoose = require('mongoose');

const TelemetrySchema = new mongoose.Schema(
  {
    homeId:   { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    device:   { type: mongoose.Schema.Types.ObjectId, ref: 'Device' },

    // e.g., 'AIR' for AirNode data, 'STOVE' for StoveNode data
    stream:   { type: String, enum: ['AIR', 'STOVE'], required: true, index: true },

    // Flexible payload to hold measurements (CO2, CO, PM, temp, humidity, stoveTemp, etc.)
    payload:  { type: Object, required: true },

    // Measurement timestamp (defaults to now)
    ts:       { type: Date, default: Date.now, index: true }
  },
  { timestamps: true, collection: 'telemetry' }
);

// Efficient time-series queries by device and time
TelemetrySchema.index({ deviceId: 1, ts: -1 });
TelemetrySchema.index({ homeId: 1, stream: 1, ts: -1 });

module.exports = mongoose.model('Telemetry', TelemetrySchema);
