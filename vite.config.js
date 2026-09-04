import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execFile } from 'child_process'
import path from 'path'
import fs from 'fs'

function scrapePlugin() {
  return {
    name: 'scrape-api',
    configureServer(server) {
      // Discover endpoint
      server.middlewares.use('/api/discover', (req, res) => {
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
            const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../games-retrieval');
            const discoverPath = path.resolve(projectRoot, 'scrapers/discover.py');
            const env = {
              ...process.env,
              SUPABASE_KEY: process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3dmJqbW50dWVyc3ZodnF4dXhxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NDIxMDkyNCwiZXhwIjoyMDc5Nzg2OTI0fQ.cCM7a3zSe8r99NWUm-ij5yijfblP19nAQ48Ifsqhcqg',
            };
            execFile('python3', [discoverPath, '--save', url], {
              cwd: path.resolve(projectRoot, 'scrapers'),
              timeout: 300000,
              env,
            }, (err, stdout, stderr) => {
              res.setHeader('Content-Type', 'application/json');
              if (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: stderr || err.message }));
              } else {
                try {
                  const result = JSON.parse(stdout);
                  res.end(JSON.stringify(result));
                } catch (e) {
                  res.end(JSON.stringify({ error: 'Invalid JSON from discover', stdout }));
                }
              }
            });
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });

      // Scrape-to-stage endpoint (scrape URL → move data to existing stage)
      server.middlewares.use('/api/scrape-stage', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { url, mappings } = JSON.parse(body);
            if (!url || !mappings) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'url and mappings are required' }));
              return;
            }
            const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../games-retrieval');
            const scriptPath = path.resolve(projectRoot, 'scrapers/scrape_to_stage.py');
            const env = {
              ...process.env,
              SUPABASE_KEY: process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3dmJqbW50dWVyc3ZodnF4dXhxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NDIxMDkyNCwiZXhwIjoyMDc5Nzg2OTI0fQ.cCM7a3zSe8r99NWUm-ij5yijfblP19nAQ48Ifsqhcqg',
            };
            execFile('python3', [scriptPath, url, '--mappings', JSON.stringify(mappings)], {
              cwd: path.resolve(projectRoot, 'scrapers'),
              timeout: 600000,
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

      // Scrape endpoint
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

            const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../games-retrieval');
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
              timeout: 600000,
              env,
            }, (err, stdout, stderr) => {
              res.setHeader('Content-Type', 'application/json');
              if (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: stderr || err.message, stdout }));
              } else {
                const tidMatch = stdout.match(/^TOURNAMENT_ID:(.+)$/m);
                const tournament_id = tidMatch ? tidMatch[1].trim() : null;
                res.end(JSON.stringify({ success: true, stdout, tournament_id }));
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
  resolve: {
    alias: {
      ...(fs.existsSync(path.resolve('../ips')) ? { 'ips': path.resolve('../ips') } : {}),
      ...(fs.existsSync(path.resolve('../games-retrieval')) ? { 'games-retrieval': path.resolve('../games-retrieval') } : {}),
      ...(fs.existsSync(path.resolve('../games-display')) ? { 'games-display': path.resolve('../games-display') } : {}),
      react: path.resolve('./node_modules/react'),
      'react-dom': path.resolve('./node_modules/react-dom'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/bridge-problems': {
        target: 'http://localhost:5173',
        changeOrigin: true,
      },
      '/bridge-lib': {
        target: 'http://localhost:5173',
        changeOrigin: true,
      },
    },
  },
})
