export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    transcriptApiKey: '',
    transcriptApiBaseUrl: 'https://transcriptapi.com/api/v2',
    openaiApiKey: '',
    openaiModel: process.env.OPENAI_MODEL ?? 'gpt-6-luna',
    openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT ?? 'low',
    scanStorageDir: '/data/scans',
    allowDiagnosticStorage: false,
    logLevel: 'info',
    public: {
      appName: 'YT Checker',
      defaultStorageMode: 'minimal',
      defaultTranscriptLanguage: '',
    },
  },
  typescript: {
    strict: true,
  },
})
