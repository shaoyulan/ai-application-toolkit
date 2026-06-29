export default defineNuxtConfig({
  modules: ['@nuxt/content'],
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  content: {
    build: {
      markdown: {
        highlight: {
          theme: 'github-dark'
        }
      }
    }
  },
  app: {
    head: {
      title: 'AI Application Toolkit',
      meta: [
        {
          name: 'description',
          content: 'Composable provider-agnostic toolkit for AI applications.'
        }
      ]
    }
  }
})
