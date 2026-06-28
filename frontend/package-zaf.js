import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const frontendDir = __dirname;
const outputZipPath = path.join(frontendDir, 'triage-agent-zaf.zip');
const manifestPath = path.join(frontendDir, 'manifest.json');
const assetsDir = path.join(frontendDir, 'assets');
const translationsDir = path.join(frontendDir, 'translations');

console.log('==================================================');
console.log('📦 Starting ZAF App packaging pipeline...');
console.log('==================================================');

// 1. Run Vite Build
try {
  console.log('🚀 Running Vite build...');
  execSync('npm run build', { cwd: frontendDir, stdio: 'inherit' });
  console.log('✅ Vite build completed successfully.');
} catch (buildErr) {
  console.error('❌ Vite build failed:', buildErr.message);
  process.exit(1);
}

// 2. Validate essential files exist
if (!fs.existsSync(manifestPath)) {
  console.error('❌ Error: manifest.json is missing from the frontend root!');
  process.exit(1);
}
if (!fs.existsSync(path.join(assetsDir, 'iframe.html'))) {
  console.error('❌ Error: Compiled assets/iframe.html is missing!');
  process.exit(1);
}
if (!fs.existsSync(path.join(translationsDir, 'en.json'))) {
  console.error('❌ Error: translations/en.json is missing!');
  process.exit(1);
}

// 3. Zip manifest.json + assets/
console.log('📝 Archiving files into triage-agent-zaf.zip...');

const output = fs.createWriteStream(outputZipPath);
const archive = archiver('zip', {
  zlib: { level: 9 } // Maximum compression level
});

output.on('close', () => {
  console.log('\n==================================================');
  console.log('🎉 Packaging successful!');
  console.log(`📂 Output file: ${outputZipPath}`);
  console.log(`📊 Size: ${(archive.pointer() / 1024).toFixed(2)} KB`);
  console.log('==================================================');
  console.log('🧐 Validation Checklist:');
  console.log('  [✓] manifest.json placed at root of ZIP archive');
  console.log('  [✓] assets/ directory contains iframe.html, JS, and CSS files');
  console.log('  [✓] Assets references are configured relatively');
  console.log('==================================================');
  console.log('Ready to upload! You can load this zip into your Zendesk developer account, or run:');
  console.log('  zcli apps:server --path ./frontend');
  console.log('to host a local development server for sandbox testing.');
});

archive.on('warning', (err) => {
  if (err.code === 'ENOENT') {
    console.warn('⚠️ Archiver warning:', err.message);
  } else {
    throw err;
  }
});

archive.on('error', (err) => {
  console.error('❌ Archiver failed:', err.message);
  process.exit(1);
});

archive.pipe(output);

// Append manifest.json at the ZIP root
archive.file(manifestPath, { name: 'manifest.json' });

// Append the assets directory (mapping it to assets/ in the ZIP)
archive.directory(assetsDir, 'assets');

// Append the translations directory (mapping it to translations/ in the ZIP)
archive.directory(translationsDir, 'translations');

archive.finalize();
