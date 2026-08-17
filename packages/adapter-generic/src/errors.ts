// Shared coded-error helper for adapter ingestion failures: every breach is a
// stable error code, never a hang or a bare throw.
export const codedError=(code:string,message:string,cause?:unknown)=>Object.assign(new Error(message,{cause}),{code});
