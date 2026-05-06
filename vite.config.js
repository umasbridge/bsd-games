import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execFile } from 'child_process'
import path from 'path'

function scrapePlugin() {
  return {
    name: 'scrape-api',
    configureServer(server) {
      server.middlewares.use('/api/scrape', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { url } = JSON.parse(body);
            if (!url) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'url is required' }));
              return;
            }

            const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname));
            let scraperFile = 'scrapers/srini.py';
            if (url.includes('lovebridge.com')) scraperFile = 'scrapers/lovebridge.py';
            else if (url.includes('bridgewebs.com')) scraperFile = 'scrapers/bridgewebs.py';
            else if (url.includes('wbbridge.in')) scraperFile = 'scrapers/sg.py';
            const scraperPath = path.resolve(projectRoot, scraperFile);

            const env = {
              ...process.env,
              SUPABASE_KEY: process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3dmJqbW50dWVyc3ZodnF4dXhxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NDIxMDkyNCwiZXhwIjoyMDc5Nzg2OTI0fQ.cCM7a3zSe8r99NWUm-ij5yijfblP19nAQ48Ifsqhcqg',
            };

            execFile('python3', [scraperPath, url], {
              cwd: projectRoot,
              timeout: 300000,
              env,
            }, (err, stdout, stderr) => {
              res.setHeader('Content-Type', 'application/json');
              if (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: stderr || err.message, stdout }));
              } else {
                res.end(JSON.stringify({ success: true, stdout }));
              }
            });
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), scrapePlugin()],
  server: {
    port: 5174,
  },
})
