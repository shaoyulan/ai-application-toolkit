<template>
  <div class="layout">
    <aside class="sidebar">
      <NuxtLink to="/" class="brand">AI Toolkit</NuxtLink>
      <nav>
        <NuxtLink to="/vision">Vision</NuxtLink>
        <NuxtLink to="/architecture">Architecture</NuxtLink>
        <NuxtLink to="/concepts/tool">Tool</NuxtLink>
        <NuxtLink to="/concepts/runtime">Runtime</NuxtLink>
        <NuxtLink to="/concepts/context">Context</NuxtLink>
        <NuxtLink to="/deployment/npm">npm Release</NuxtLink>
        <NuxtLink to="/deployment/vercel">Vercel Docs</NuxtLink>
      </nav>
    </aside>
    <main class="content">
      <slot />
    </main>
  </div>
</template>
