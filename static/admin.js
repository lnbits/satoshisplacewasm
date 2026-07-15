const client = window.createLNbitsExtensionClient({
  extensionId: 'satoshisplacewasm'
})

const app = Vue.createApp({
  data() {
    return {
      loading: false,
      creating: false,
      deletingWallId: '',
      wallets: [],
      walls: [],
      search: '',
      wallForm: {
        name: 'Satoshi wall',
        description: '',
        walletId: '',
        width: 64,
        height: 64,
        pricePerPixel: 1,
        enabled: true
      },
      pagination: {
        sortBy: 'createdAt',
        descending: true,
        page: 1,
        rowsPerPage: 10,
        rowsNumber: 0
      },
      columns: [
        {name: 'name', label: 'Wall', field: 'name', align: 'left', sortable: true},
        {name: 'size', label: 'Size', field: 'width', align: 'left', sortable: false},
        {name: 'price', label: 'Sat/px', field: 'pricePerPixel', align: 'right', sortable: true},
        {name: 'painted', label: 'Paid px', field: 'paidPixels', align: 'right', sortable: true},
        {name: 'enabled', label: 'Status', field: 'enabled', align: 'left', sortable: false},
        {name: 'actions', label: '', field: 'id', align: 'right', sortable: false}
      ]
    }
  },

  computed: {
    selectedWalletName() {
      return this.wallets.find(wallet => wallet.id === this.effectiveWalletId)?.name || ''
    },

    effectiveWalletId() {
      return this.wallForm.walletId || this.wallets[0]?.id || ''
    },

    canCreate() {
      return (
        this.effectiveWalletId &&
        this.wallForm.name &&
        Number(this.wallForm.width) > 0 &&
        Number(this.wallForm.height) > 0 &&
        Number(this.wallForm.pricePerPixel) > 0
      )
    }
  },

  async mounted() {
    this.loading = true
    try {
      await Promise.all([this.fetchWallets(), this.fetchWalls()])
    } finally {
      this.loading = false
    }
  },

  methods: {
    async fetchWallets() {
      try {
        const response = await client.listWallets()
        this.wallets = response.wallets || []
        if (!this.wallForm.walletId && this.wallets.length) {
          this.wallForm.walletId = this.wallets[0].id
        }
      } catch (error) {
        this.showError(error)
      }
    },

    async createWall() {
      if (!this.canCreate) return
      this.creating = true
      try {
        await client.createWall({
          ...this.wallForm,
          walletId: this.effectiveWalletId,
          walletName: this.selectedWalletName,
          width: Number(this.wallForm.width),
          height: Number(this.wallForm.height),
          pricePerPixel: Number(this.wallForm.pricePerPixel)
        })
        this.notify('Wall created.', 'positive')
        await this.fetchWalls()
      } catch (error) {
        this.showError(error)
      } finally {
        this.creating = false
      }
    },

    async fetchWalls(props = {}) {
      const pagination = props.pagination || this.pagination
      try {
        const response = await client.listWalls({
          page: pagination.page,
          rowsPerPage: pagination.rowsPerPage,
          sortBy: pagination.sortBy,
          descending: pagination.descending,
          search: this.search
        })
        this.walls = response.walls || []
        this.pagination = {...pagination, rowsNumber: response.total || 0}
      } catch (error) {
        this.showError(error)
      }
    },

    publicUrl(wall) {
      return new URL(`/ext/satoshisplacewasm/walls/${encodeURIComponent(wall.id)}`, window.location.href).href
    },

    async copyWall(wall) {
      try {
        await navigator.clipboard.writeText(this.publicUrl(wall))
        this.notify('Wall link copied.', 'positive')
      } catch (_error) {
        this.notify('Failed to copy wall link.', 'negative')
      }
    },

    async deleteWall(wall) {
      const confirmed = await this.confirmAction({
        title: 'Delete Wall',
        message: `Delete "${wall.name}"? This removes the wall and its paint records.`,
        okLabel: 'Delete',
        okColor: 'negative'
      })
      if (!confirmed) return
      this.deletingWallId = wall.id
      try {
        await client.deleteWall(wall.id)
        this.notify('Wall deleted.', 'positive')
        await this.fetchWalls()
      } catch (error) {
        this.showError(error)
      } finally {
        this.deletingWallId = ''
      }
    },

    confirmAction({title, message, okLabel = 'OK', okColor = 'primary'}) {
      return new Promise(resolve => {
        Quasar.Dialog.create({
          dark: true,
          title,
          message,
          cancel: true,
          persistent: true,
          ok: {label: okLabel, color: okColor}
        })
          .onOk(() => resolve(true))
          .onCancel(() => resolve(false))
          .onDismiss(() => resolve(false))
      })
    },

    notify(message, type = 'info') {
      Quasar.Notify.create({type, message})
    },

    showError(error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[satoshisplacewasm admin]', message, error)
      this.notify(message, 'negative')
    }
  },

  render() {
    const h = Vue.h
    const component = name => Vue.resolveComponent(name)
    const QBadge = component('q-badge')
    const QBtn = component('q-btn')
    const QCard = component('q-card')
    const QInput = component('q-input')
    const QLayout = component('q-layout')
    const QTable = component('q-table')
    const QTd = component('q-td')
    const QToggle = component('q-toggle')
    const QTooltip = component('q-tooltip')

    const formInput = (field, props = {}, parse = value => value) =>
      h(QInput, {
        modelValue: this.wallForm[field],
        'onUpdate:modelValue': value => {
          this.wallForm[field] = parse(value)
        },
        filled: true,
        dense: true,
        dark: true,
        ...props
      })

    return h(QLayout, {view: 'hHh lpR fFf', class: 'place-shell q-pa-md'}, () => [
      h('div', {class: 'brand-row q-mb-md'}, [
        h('div', {class: 'place-mark', 'aria-hidden': 'true'}, '▦'),
        h('div', [
          h('h1', {class: 'text-h4 text-weight-bold q-my-none'}, "Satoshi's Place"),
          h('p', {class: 'text-subtitle2 text-grey-5 q-my-none'}, 'Paid collaborative pixel walls.')
        ])
      ]),

      h('div', {class: 'row q-col-gutter-md'}, [
        h('div', {class: 'col-12 col-md-4'}, [
          h(QCard, {dark: true, class: 'panel q-pa-md'}, () => [
            h('h2', {class: 'text-h6 text-weight-bold q-my-none q-mb-md'}, 'New Wall'),
            formInput('name', {label: 'Name'}, value => String(value || '').trim()),
            formInput('description', {label: 'Description', class: 'q-mt-sm'}, value => String(value || '').trim()),
            h('div', {class: 'row q-col-gutter-sm q-mt-xs'}, [
              h('div', {class: 'col-6'}, [
                formInput('width', {type: 'number', min: 8, max: 128, label: 'Width'}, Number)
              ]),
              h('div', {class: 'col-6'}, [
                formInput('height', {type: 'number', min: 8, max: 128, label: 'Height'}, Number)
              ])
            ]),
            formInput('pricePerPixel', {type: 'number', min: 1, label: 'Sats per pixel', class: 'q-mt-sm'}, Number),
            h(QToggle, {
              class: 'q-mt-sm',
              modelValue: this.wallForm.enabled,
              'onUpdate:modelValue': value => {
                this.wallForm.enabled = value
              },
              label: 'Accept graffiti',
              color: 'primary'
            }),
            h(QBtn, {
              class: 'q-mt-md',
              color: 'primary',
              loading: this.creating,
              disable: !this.canCreate,
              onClick: this.createWall
            }, () => 'Create Wall')
          ])
        ]),

        h('div', {class: 'col-12 col-md-8'}, [
          h(QCard, {dark: true, class: 'panel q-pa-md'}, () => [
            h('div', {class: 'row items-center q-col-gutter-sm q-mb-md'}, [
              h('div', {class: 'col'}, [
                h('h2', {class: 'text-h6 text-weight-bold q-my-none'}, 'Walls')
              ]),
              h('div', {class: 'col-12 col-sm-5'}, [
                h(QInput, {
                  modelValue: this.search,
                  'onUpdate:modelValue': value => {
                    this.search = value
                  },
                  debounce: 300,
                  filled: true,
                  dense: true,
                  dark: true,
                  clearable: true,
                  label: 'Search',
                  onClear: () => {
                    this.search = ''
                    this.fetchWalls()
                  },
                  onKeyup: event => {
                    if (event.key === 'Enter') this.fetchWalls()
                  }
                })
              ])
            ]),
            h(QTable, {
              dark: true,
              flat: true,
              rows: this.walls,
              columns: this.columns,
              rowKey: 'id',
              loading: this.loading,
              pagination: this.pagination,
              'onUpdate:pagination': value => {
                this.pagination = value
              },
              onRequest: this.fetchWalls
            }, {
              'body-cell-size': props =>
                h(QTd, {props}, () => `${props.row.width} x ${props.row.height}`),
              'body-cell-price': props =>
                h(QTd, {props}, () => `${props.row.pricePerPixel}`),
              'body-cell-enabled': props =>
                h(QTd, {props}, () =>
                  h(QBadge, {color: props.row.enabled ? 'positive' : 'grey'}, () =>
                    props.row.enabled ? 'Open' : 'Closed'
                  )
                ),
              'body-cell-actions': props =>
                h(QTd, {props, class: 'text-right'}, () => [
                  h(QBtn, {
                    dense: true,
                    round: true,
                    flat: true,
                    icon: 'content_copy',
                    onClick: () => this.copyWall(props.row)
                  }, () => h(QTooltip, () => 'Copy public link')),
                  h(QBtn, {
                    dense: true,
                    round: true,
                    flat: true,
                    color: 'negative',
                    icon: 'delete',
                    loading: this.deletingWallId === props.row.id,
                    onClick: () => this.deleteWall(props.row)
                  }, () => h(QTooltip, () => 'Delete wall')),
                  h(QBtn, {
                    dense: true,
                    round: true,
                    flat: true,
                    icon: 'open_in_new',
                    href: this.publicUrl(props.row),
                    target: '_blank'
                  }, () => h(QTooltip, () => 'Open wall'))
                ])
            })
          ])
        ])
      ])
    ])
  }
})

app.use(Quasar)
app.mount('#place-admin-app')
