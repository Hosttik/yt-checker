export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    transcriptApiKey: '',
    transcriptApiBaseUrl: 'https://transcriptapi.com/api/v2',
    public: {
      appName: 'YT Checker',
    },
  },
  typescript: {
    strict: true,
  },
})
