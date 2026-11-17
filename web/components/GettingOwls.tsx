import Link from "next/link";
import { permissionPhrase } from "../lib/admin-words";
import {
  BUY_OWLS_HREF,
  CREATE_OWLS_HREF,
  CREATES_OWLS,
  WHO_HOLDS_HREF,
  type OwlSource,
} from "../lib/owl-source";

// How to get more owls, where a balance cannot cover something: "Buy owls"
// only where owls are sold; where they are created here, who creates them
// and where, with the place to do it for someone who may (#1095). No hooks,
// so server and client components both render it.
export function GettingOwls({ source, buyHref = BUY_OWLS_HREF }: { source: OwlSource; buyHref?: string }) {
  switch (source.kind) {
    case "sold":
      return <Link href={buyHref}>Buy owls</Link>;
    case "created":
      return source.administers ? (
        <>
          Owls here are created by this deployment&rsquo;s administrators, into a person&rsquo;s
          balance, and you hold the permission to {permissionPhrase(CREATES_OWLS)}.{" "}
          <Link href={CREATE_OWLS_HREF}>Create owls under Administration → Owls</Link>
        </>
      ) : (
        <>
          Owls here are created by this deployment&rsquo;s administrators: anyone who holds the
          permission to {permissionPhrase(CREATES_OWLS)} can create owls into your balance, under
          Administration → Owls. Ask one of them; <Link href={WHO_HOLDS_HREF}>People and
          permissions</Link> lists who holds it.
        </>
      );
    case "none":
      return <>Owls are not sold on this deployment.</>;
  }
}
