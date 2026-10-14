// Browser entry: mounts the treemap on #app and starts polling `/api/map`.
import { mountApp } from './app.js';
import './style.css';

const host = document.getElementById('app');
if (host) {
  const app = mountApp(host, { fetch: (url, init) => fetch(url, init), window });
  // Size the treemap once the first box has been laid out.
  requestAnimationFrame(() => app.render());
}
