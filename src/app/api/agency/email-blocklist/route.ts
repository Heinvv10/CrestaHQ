// Stub — see publish/README.md. Mothership-only tool; inert in buyer clones.
export async function POST(): Promise<Response> {
  return new Response("Not found", { status: 404 });
}

export async function DELETE(): Promise<Response> {
  return new Response("Not found", { status: 404 });
}
