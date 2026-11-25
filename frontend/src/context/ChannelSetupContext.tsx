import { createContext, useContext } from 'react';

/**
 * ¿El usuario todavía no vinculó WhatsApp ni Telegram? Lo sabe el Dashboard
 * (GET /verify/status) y lo leen los encabezados de cada pestaña: el "Pedile al
 * bot" no sirve de nada sin un canal, y un usuario nuevo buscaba un botón para
 * cargar su primer gasto en la web (QA nov 2026). Fuera del Dashboard el
 * default no muestra nada.
 */
export interface ChannelSetup {
  needsChannel: boolean;
  goToAccount: () => void;
}

const ChannelSetupContext = createContext<ChannelSetup>({ needsChannel: false, goToAccount: () => {} });

export const ChannelSetupProvider = ChannelSetupContext.Provider;

export function useChannelSetup(): ChannelSetup {
  return useContext(ChannelSetupContext);
}
