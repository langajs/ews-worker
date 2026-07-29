export async function runAuthenticatedRoute(request, env, handler, authenticate, responses) {
  try {
    const auth = await authenticate(request, env);
    if (!auth.valid) return responses.unauthorized();
    request.auth = auth;
    return await handler();
  } catch (err) {
    return responses.failed(err);
  }
}
