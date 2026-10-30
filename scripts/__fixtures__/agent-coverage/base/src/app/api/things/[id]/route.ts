export async function PATCH() {
  return new Response("ok");
}

// Not keyed: a companion of a keyed method, never an operation of its own.
export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
