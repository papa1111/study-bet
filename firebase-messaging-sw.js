// 사이트가 꺼져 있어도 알림을 받는 백그라운드 스크립트
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAGmRT4K_y2l4qP7A2sG8PWyGUNjnyapt8",
  authDomain: "study-bet-dd58b.firebaseapp.com",
  projectId: "study-bet-dd58b",
  storageBucket: "study-bet-dd58b.firebasestorage.app",
  messagingSenderId: "48290934455",
  appId: "1:48290934455:web:c3d56fae53812a45b4a732"
});

const messaging = firebase.messaging();
// notification 형식 메시지는 SDK가 자동으로 표시함. 데이터만 온 경우 대비
messaging.onBackgroundMessage(payload => {
  if (payload.notification) return;
  const d = payload.data || {};
  self.registration.showNotification(d.title || "공부 내기판", { body: d.body || "", icon: "./icon-192.png" });
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if ("focus" in c) return c.focus();
    return clients.openWindow("./");
  })());
});
