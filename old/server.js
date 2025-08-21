// server.js - Main Entry Point
const app = require('./src/app');
const logger = require('./src/utils/logger');

const PORT = process.env.PORT || 3000;

// Start server
app.listen(PORT, () => {
    logger.info(`🚀 SHEGA Backend Server running on http://localhost:${PORT}`);
    logger.info(`📊 API Documentation: http://localhost:${PORT}`);
    logger.info(`🔧 System Status: http://localhost:${PORT}/api/system/status`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    logger.info('\n🛑 Shutting down server...');
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});