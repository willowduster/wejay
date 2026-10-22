import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.js',
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }]],
  use: { baseURL: 'http://localhost:5173', viewport: { width: 1440, height: 960 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'npm run dev -- --port 5173', url: 'http://localhost:5173', reuseExistingServer: true },
    { command: 'go run .', cwd: './server', url: 'http://localhost:8080/api/health', reuseExistingServer: true },
  ],
})