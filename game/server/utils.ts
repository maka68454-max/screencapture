// https://github.com/overextended/ox_target/blob/main/client/compat/qtarget.lua#L1
export function exportHandler(exportName: string, func: (...args: any[]) => any): void {
  AddEventHandler(`__cfx_export_screenshot-basic_${exportName}`, (setCB: (cb: (...args: any[]) => any) => void) => {
    setCB(func);
  });
}