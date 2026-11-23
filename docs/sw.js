/* Serve só para o navegador/iPhone poder mostrar avisos do jogo (não guarda nada em cache). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(l => (l.length ? l[0].focus() : self.clients.openWindow("./"))));
});
