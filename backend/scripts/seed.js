require('dotenv').config();
const { connectMongo } = require('../src/config/mongo');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');

(async () => {
  try {
    await connectMongo();
    const email ="admin@gmail.com"
    //  process.env.ADMIN_EMAIL || 'admin@shega.local';
    const pass  ="12345678"
    //  process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    const name  = 'SHEGA Admin';

    let admin = await User.findOne({ email });
    if (!admin) {
      admin = await User.create({
        email,
        password: await bcrypt.hash(pass, 10),
        role: 'admin',
        name,
        homes: [] // admin sees all homes via role, not list
      });
      console.log('✅ Admin created:', email);
    } else {
      console.log('ℹ️  Admin already exists:', email);
    }
    process.exit(0);
  } catch (e) {
    console.error('Seed failed:', e);
    process.exit(1);
  }
})();
