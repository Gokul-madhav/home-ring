const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting QR Doorbell System...\n');

// Start main backend server
const backendServer = spawn('node', ['qr-doorbell-backend/index.js'], {
  cwd: __dirname,
  stdio: 'inherit'
});

// Start visitor server
const visitorServer = spawn('node', ['qr-doorbell-backend/visitorServer.js'], {
  cwd: __dirname,
  stdio: 'inherit'
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down servers...');
  backendServer.kill();
  visitorServer.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down servers...');
  backendServer.kill();
  visitorServer.kill();
  process.exit(0);
});

// Handle server crashes
backendServer.on('close', (code) => {
  console.log(`❌ Backend server exited with code ${code}`);
  visitorServer.kill();
  process.exit(code);
});

visitorServer.on('close', (code) => {
  console.log(`❌ Visitor server exited with code ${code}`);
  backendServer.kill();
  process.exit(code);
});

console.log('✅ Both servers started successfully!');
console.log('📱 Main API server: http://localhost:5000');
console.log('🌐 Visitor interface: http://localhost:3000');
console.log('📱 Flutter app should connect to: http://localhost:5000');
console.log('\nPress Ctrl+C to stop all servers\n'); 