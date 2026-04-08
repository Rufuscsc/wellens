const { app } = require('electron');
console.log('app type:', typeof app);
console.log('app.getVersion:', app ? app.getVersion() : 'N/A');
if (app) {
  app.whenReady().then(() => {
    console.log('userData:', app.getPath('userData'));
    app.quit();
  });
} else {
  console.log('ERROR: app is undefined');  
  process.exit(1);
}
