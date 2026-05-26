export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN ?? process.env.CLERK_ISSUER_URL,
      applicationID: "convex",
    },
  ],
};
