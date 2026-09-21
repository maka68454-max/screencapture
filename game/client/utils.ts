export const uuidv4 = (): string => {
    let uuid = '';
    for (let ii = 0; ii < 32; ii += 1) {
      switch (ii) {
        case 8:
        case 20:
          uuid += '-';
          uuid += ((Math.random() * 16) | 0).toString(16);
          break;
        case 12:
          uuid += '-';
          uuid += '4';
          break;
        case 16:
          uuid += '-';
          uuid += ((Math.random() * 4) | 8).toString(16);
          break;
        default:
          uuid += ((Math.random() * 16) | 0).toString(16);
      }
    }
    return uuid;
  };


// https://github.com/overextended/ox_target/blob/main/client/compat/qtarget.lua#L1
export function exportHandler(exportName: string, func: (...args: any[]) => any): void {
  AddEventHandler(`__cfx_export_screenshot-basic_${exportName}`, (setCB: (cb: (...args: any[]) => any) => void) => {
    setCB(func);
  });
}