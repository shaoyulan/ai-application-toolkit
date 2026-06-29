<script setup lang="ts">
const { data: page } = await useAsyncData('index', () => queryCollection('content').path('/').first())
</script>

<template>
  <article class="prose">
    <ContentRenderer v-if="page" :value="page" />
  </article>
</template>
