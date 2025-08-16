import indexHtml from "./index.html";

const server = Bun.serve({
  port: 3001,
  fetch(req) {
    const url = new URL(req.url);
    
    // Serve index.html for root
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html" }
      });
    }
    
    // Let Bun handle other static files
    return new Response("Not Found", { status: 404 });
  },
  development: {
    hmr: true,
    console: true,
  }
});

console.log(`🚀 FormGenNext running at http://localhost:${server.port}`);
console.log(`📝 Open in browser to generate campaign letters`);