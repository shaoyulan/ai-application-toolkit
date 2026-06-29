<script setup lang="ts">
const route = useRoute()
const path = '/' + (route.params.slug as string[] | undefined || []).join('/')
const { data: page } = await useAsyncData(path, () => queryCollection('content').path(path).first())
</script>

<template>
  <article v-if="page" class="prose">
    <ContentRenderer :value="page" />
  </article>
  <article v-else class="prose">
    <h1>Not Found</h1>
    <p>The requested documentation page does not exist.</p>
  </article>
</template>
