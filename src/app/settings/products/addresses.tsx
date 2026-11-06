import type { ProductAddress } from "@/application/product-addresses";
import { ActionForm, ConfirmButton, TryButton } from "@/components/try-button";
import { Badge, INLINE_FIELD } from "@/components/ui";
import { addAddressAction, removeAddressAction, setScreeningAction } from "./actions";

function AddressRow({ address, mayChange }: { address: ProductAddress; mayChange: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 font-mono text-xs break-all">{address.value}</span>
      <Badge tone={address.screens ? "plain" : "calm"}>{address.screens ? "Screened first" : "Opens a ticket"}</Badge>
      {mayChange && (
        <span className="flex flex-wrap items-center gap-2">
          <TryButton action={setScreeningAction.bind(null, address.id, !address.screens)} label={address.screens ? "Open tickets instead" : "Screen first instead"} busy="…" />
          <ConfirmButton action={removeAddressAction.bind(null, address.id)} label="Remove" confirm="Confirm: its new mail goes to Screened" />
        </span>
      )}
    </li>
  );
}

/** Every address and domain a product answers for, beyond its support address, so a site's mail finds its product. */
export function ProductAddresses({ productId, addresses, mayChange }: { productId: string; addresses: ProductAddress[]; mayChange: boolean }) {
  return (
    <div className="mt-5 border-t pt-5">
      <h3 className="text-sm font-medium">Where else it receives</h3>
      <p className="mt-1 text-sm text-muted-foreground">An address, or a domain for every address on it. New mail there opens a ticket for this product, or waits in Screened with this product already chosen. Mail on no address of any product waits in Screened too. Replies still leave from the support address.</p>
      {addresses.length > 0 && (
        <ul className="mt-3 space-y-2">
          {addresses.map((address) => (
            <AddressRow key={address.id} address={address} mayChange={mayChange} />
          ))}
        </ul>
      )}
      {mayChange && (
        <div className="mt-3">
          <ActionForm action={addAddressAction.bind(null, productId)} submit="Add" busy="…" quiet className="flex flex-wrap items-center gap-3">
            <input name="value" required maxLength={254} placeholder="help@acme.example or acme.example" aria-label="An address or a domain" className={`${INLINE_FIELD} min-w-64 flex-1`} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="screens" />
              Screen first
            </label>
          </ActionForm>
        </div>
      )}
    </div>
  );
}
