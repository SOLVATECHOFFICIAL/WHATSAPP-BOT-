export default async function ping({ reply, startedAt }) {
  await reply(`Pong! ${Date.now() - startedAt}ms`);
}