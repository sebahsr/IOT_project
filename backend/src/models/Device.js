const mongoose = require('mongoose');

const DeviceSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, unique: true, index: true },
    homeId:   { type: String, required: true, index: true },

    type:     { type: String, enum: ['AIRNODE', 'STOVENODE'], required: true, index: true },
    name:     { type: String, default: '' },
    location: { type: String, default: '' }, // e.g., "Kitchen", "Living Room"

    owner:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // optional link

    firmware: { type: String, default: '' },
    status:   { type: String, enum: ['online', 'offline', 'unknown'], default: 'unknown', index: true },
    lastSeenAt: { type: Date },

    metadata: { type: Object, default: {} }
  },
  { timestamps: true, collection: 'devices' }
);

// Helpful compound index for admin overview per home
DeviceSchema.index({ homeId: 1, type: 1, status: 1 });

module.exports = mongoose.model('Device', DeviceSchema);
