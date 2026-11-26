// Preloaded only in the browser test's server process. All provider traffic stays on its fixture port.
const send = globalThis.fetch;
const fixture = new URL(`http://127.0.0.1:${process.env.AGS_TEST_PROVIDER_PORT}`);
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  if (url.origin === "https://api.openai.com") return send(new URL(`/openai${url.pathname}`, fixture), init);
  if (url.origin === fixture.origin) return send(url, init);
  throw new Error("Unexpected provider in browser test");
};
