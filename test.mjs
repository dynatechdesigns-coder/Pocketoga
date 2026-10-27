const res = await fetch("https://api.meta.ai/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.META_API_KEY}`,
  },
  body: JSON.stringify({
    model: "muse-spark-1.3", // use the exact model name shown in your dashboard
    messages: [{ role: "user", content: "Say hello in Nigerian Pidgin." }],
  }),
});
console.log(res.status, await res.json());