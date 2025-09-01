async function saveEmergency(e) {
  const doc = new Emergency(e);
  return await doc.save();
}

module.exports = { saveEmergency };
