# Forever auction data

Research checked 2026-11-08 against US Blizzard endpoints and client build
`1.60.1.70862`. Prices are enabled only for a market configured as `auctionMarket`
in the private roster config (see README).

## Blizzard can supply listings

The official [developer portal](https://develop.battle.net/documentation/world-of-warcraft/game-data-apis)
does not currently publish a Forever-specific auction contract. The
[client author's forum report](https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334)
and [client implementation at 26e36ce](https://github.com/Pinta365/blizzard_api/blob/26e36ce2e29b7720440db61bf3c52f9b1323038a/src/wow_forever/auction_house.ts)
describe these routes. Read-only authenticated US probes confirmed successful
responses today, using the existing credentials and header authentication:

| Route, with `namespace=dynamic-forever-{region}`               | Observed data                                          |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| `/data/wow/ruleset/index`                                      | Ruleset IDs                                            |
| `/data/wow/ruleset/{rulesetId}`                                | Ruleset name                                           |
| `/data/wow/ruleset/{rulesetId}/auctions/`                      | House IDs and names; the final slash is required       |
| `/data/wow/ruleset/{rulesetId}/auctions/{houseId}`             | Auction IDs, item IDs, quantities, optional buyout/bid |
| `/data/wow/ruleset/{rulesetId}/auctions/{houseId}/commodities` | Item IDs, quantities and unit prices                   |

No external service is inherently required for current asking prices. This is
listing data, not completed sales or guaranteed sale prices. Historical prices
would require retaining snapshots or using a provider with history.

## The market still needs corroboration

Changing the ruleset path is not sufficient: today's probe returned exactly the
same auction listings for house 110 under rulesets 1 and 3. The index lists five
identically named Alliance houses. Never merge these markets or select the first
house with the right faction name.

A possible bridge exists in Blizzard's client data, mirrored by wago.tools:

- [AvailableSuperDistrict](https://wago.tools/db2/AvailableSuperDistrict/csv?build=1.60.1.70862&format=csv)
  identifies the Roleplay display row as ID 4, with SuperDistrictID 3.
- [AuctionHouseRedirect](https://wago.tools/db2/AuctionHouseRedirect/csv?build=1.60.1.70862&format=csv)
  has rows consistent with display-row ID 4 redirecting Alliance to house 119,
  Horde to 120 and Blackwater to 121. Display-row ID 7 corresponds to Roleplay
  PvP and appears to redirect to 123/124/125.
- [AuctionHouse](https://wago.tools/db2/AuctionHouse/csv?build=1.60.1.70862&format=csv)
  confirms those house names/factions.

The redirect columns still have unidentified field names in
[WoWDBDefs](https://github.com/wowdev/WoWDBDefs/blob/master/definitions/AuctionHouseRedirect.dbd).
Interpreting the middle field as the display-row ID is an inference, not a
published Blizzard API guarantee. The independent
[Hyjal US Roleplay Alliance market](https://hyjal.cc/auctions/us/rp-pve/alliance)
also identifies house 119, but this does not itself prove the assignment.

House 119 was therefore the candidate for US Alliance Roleplay. Before enabling
it, compare contemporaneous in-game listings (item identity, quantities and
buyout prices) with that API house. Prefer distinctive listings or several
items to a single common price shared by many markets. Record the evidence and
confirmed region/ruleset/faction/house in private configuration; do not hardcode
a global assignment from these observations. Keep client downloads and any
live evidence ignored.

## Verification on 2026-11-08

An in-game auction-house screenshot of Frilled Lichen (item 249399) was compared
with the commodity listings of every Alliance house about an hour old. House 119
matched 16 price/quantity levels exactly; the other Alliance houses matched
none. US Alliance Roleplay is therefore configured privately as ruleset 3
(`Roleplay`), house 119. Repeat this comparison for any other market.

## Recipe columns

The implementation shows crafted-output lowest buyout per item,
material unit prices, estimated material cost per craft, output quantity for
sale, and the auction snapshot time/source/market. Divide stack buyouts by
quantity; commodity `unit_price` is already per unit. Exclude bid-only listings
from buyout calculations. Match materials and outputs by their Blizzard item
IDs, which are already stored for the Wowhead item links.

Missing listings, missing recipe materials and unavailable requests stay
unknown. An estimated total is unavailable if any required material price is
unknown, and an insufficient quantity should be visible. Variable yields need
explicit bounds. Lowest-price estimates are asking-price indicators and may
understate the cost of purchasing all required materials. They are not profit
or sale-rate guarantees; no vendor costs, fees or unverified market prices
should be silently substituted.
