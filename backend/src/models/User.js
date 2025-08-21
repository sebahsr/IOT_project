const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    password: { type: String, required: true }, // will store hash later
    role: { type: String, enum: ['admin', 'user'], default: 'user', index: true },
    name: { type: String },
    // Option A: authorize by homes (a user can belong to one or more homes)
    homes: [{ type: String, index: true }]
  },
  { timestamps: true, collection: 'users' }
);

module.exports = mongoose.model('User', UserSchema);
