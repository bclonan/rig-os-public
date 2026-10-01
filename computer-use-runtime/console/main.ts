import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
createApp(App).mount("#app");
document.addEventListener(
  "blur",
  (event) => {
    const el = event.target;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
      el.setAttribute("aria-invalid", String(el.matches(":user-invalid")));
  },
  true,
);
