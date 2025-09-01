require('dotenv').config();
const http = require('http');
const app = require('./src/app');
const { connectMongo } = require('./src/config/mongo');
const sockets = require('./src/sockets');
const { startMqtt } = require('./src/services/mqttService');
const { config, assertConfig } = require('./src/config');
 const cookieParser = require('cookie-parser');
const PORT = process.env.PORT || 3000;(async () => {
  try {
     assertConfig();
    await connectMongo(); // <-- wait for Mongo
      // Create HTTP server and bind Socket.IO
   
app.use(cookieParser());
    const server = http.createServer(app);
    sockets.start(server);

    startMqtt(); // <-- start MQTT service
    
    server.listen(PORT, () => {
      console.log(`SHEGA Backend Server running on http://localhost:${PORT}`);
      console.log(` System Status: http://localhost:${PORT}/api/system/status`);
    });

    // Graceful shutdown
    ['SIGINT','SIGTERM'].forEach(sig => {
      process.on(sig, () => {
        console.log('\n Shutting down server...');
        server.close(() => process.exit(0));
      });
    });

  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
})();
