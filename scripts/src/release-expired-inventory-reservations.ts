const reservationsPath = "../../artifacts/api-server/src/lib/inventoryReservations";
const reservations = await import(reservationsPath) as {
  releaseExpiredInventoryReservations: () => Promise<number>;
};

const releasedReservations = await reservations.releaseExpiredInventoryReservations();
console.log(JSON.stringify({ releasedReservations }, null, 2));

export {};
