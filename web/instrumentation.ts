// Runs once when the web app starts, before it serves anything.
//
// A members-only deployment (lib/members.ts) has to be built as one. Pages
// that read nothing about their visitor are prerendered at build time and
// then served as files, without any code running, so a build made for the
// public graph and started with READS=members would hand its prerendered
// pages to anyone, whatever the sign-in gate says. That cannot be noticed
// from inside a request, so it is checked here: the error below is logged
// and the app answers every request with an error until it is rebuilt.
//
// The other way round is harmless (a members-only build renders every page
// for its reader), and on the public graph both values are "open".
export function register(): void {
  const running = process.env.READS === "members" ? "members" : "open";
  const built = process.env.MINERVAL_BUILT_READS ?? "open";
  if (running === "members" && built !== "members") {
    throw new Error(
      "This web app was built for a deployment that anyone may read, and is being started " +
        "with READS=members. Build it again with READS=members set, so that no page is " +
        "prepared ahead of time and served without a sign-in."
    );
  }
}
