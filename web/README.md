# web

The erd-designer front end: React 19, Vite, Tailwind 4, [React Flow](https://reactflow.dev), Zustand.

```
src/
  core/         Pure, framework-free logic (model types, SQL / Prisma / Drizzle generation, relations) + unit tests
  components/   Canvas nodes/edges, panels, menus, shadcn/ui primitives (components/ui)
  auth/         API client, auth store, autosave hook
  store.ts      Single Zustand store: tables, relations, selection, undo-friendly actions
```

Scripts: `npm run dev`, `npm run build`, `npm run lint`, `npm test`. In development Vite proxies `/api` to the API
on `127.0.0.1:3001`, which keeps the session cookie same-origin. See the [root README](../README.md).
