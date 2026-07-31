// App entry point. Projects replace the body of main() with their logic.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

function main() {
  document.getElementById('app').textContent = 'pockterm ready';
}

main();
