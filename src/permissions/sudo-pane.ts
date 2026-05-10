let sudoPaneAllowed = true

export function configureSudoPane(allowed: boolean): void {
  sudoPaneAllowed = allowed
}

export function assertSudoPaneAllowed(): void {
  if (!sudoPaneAllowed)
    throw new Error('sudo pane is disabled by zellij-pty config.')
}
