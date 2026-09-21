export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    youtubeApiKey: '',
    supadataApiKey: '',
    supadataBaseUrl: 'https://api.supadata.ai/v1',
    public: {
      appName: 'YT Checker',
    },
  },
  typescript: {
    strict: true,
  },
})
