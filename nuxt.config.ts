export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    transcriptApiKey: '',
    transcriptApiBaseUrl: 'https://transcriptapi.com/api/v2',
    typesafeApiKey: '',
    typesafeBaseUrl: 'https://api.typesafe.ai/v1',
    typesafeModel: 'jev-latest',
    jevBenignDismissThreshold: 0.75,
    jevViolationConfirmThreshold: 0.7,
    scanStorageDir: '/data/scans',
    allowDiagnosticStorage: false,
    logLevel: 'info',
    logRawCandidates: false,
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
