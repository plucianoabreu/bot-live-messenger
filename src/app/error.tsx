'use client';
export default function ErrorPage({reset}:{reset:()=>void}){return <main className="web-failure"><h1>Não foi possível carregar suas conversas.</h1><p>Tente novamente em instantes.</p><button className="glossy-button" onClick={reset}>Tentar novamente</button><a href="/">Voltar ao login</a></main>;}
