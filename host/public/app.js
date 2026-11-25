// Filtrage en cascade des formulaires de projet : compte Roblox -> groupe -> places.
// Amelioration progressive : sans ce script tout reste affiche, et le serveur verifie de toute facon la coherence.
(() => {
  const setVisible = (option, visible) => {
    option.hidden = !visible
    option.disabled = !visible
  }

  for (const form of document.querySelectorAll('form[data-cascade]')) {
    const account = form.querySelector('select[name="robloxAccountId"]')
    const group = form.querySelector('select[name="groupId"]')
    const placeSelects = form.querySelectorAll('select[data-place-select]')

    const refresh = () => {
      const accountId = account ? account.value : ''

      // groupes : seulement ceux du compte choisi (« aucun groupe » reste toujours possible)
      if (group) {
        for (const option of group.options) {
          setVisible(option, option.value === '' || !option.dataset.account || option.dataset.account === accountId)
        }
        if (group.selectedOptions[0] && group.selectedOptions[0].disabled) group.value = ''
      }

      // places : seulement celles du compte ET du groupe choisis (sans groupe : les experiences personnelles)
      const owner = group && group.value ? `group:${group.value}` : 'user'
      for (const select of placeSelects) {
        for (const option of select.options) {
          if (option.value === '') { setVisible(option, true); continue }
          const okAccount = !option.dataset.account || option.dataset.account === accountId
          const okOwner = !option.dataset.owner || option.dataset.owner === owner
          setVisible(option, okAccount && okOwner)
        }
        for (const optgroup of select.querySelectorAll('optgroup')) {
          optgroup.hidden = ![...optgroup.children].some((o) => !o.hidden)
        }
        if (select.selectedOptions[0] && select.selectedOptions[0].disabled) select.value = ''
      }
    }

    if (account) account.addEventListener('change', refresh)
    if (group) group.addEventListener('change', refresh)
    refresh()
  }
})()
