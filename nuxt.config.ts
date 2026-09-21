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
    typesafeBenignDropProbability: 0.8,
    public: {
      appName: 'YT Checker',
    },
  },
  typescript: {
    strict: true,
  },
})
