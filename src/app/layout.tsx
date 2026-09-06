import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {title:'Bot Live Messenger',description:'Seus bots, na sua lista de contatos.', icons:{icon:'/assets/messenger.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="pt-BR"><body data-scene="blue">{children}</body></html>;
}
