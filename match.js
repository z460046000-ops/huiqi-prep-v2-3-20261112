/* 政策匹配：企业资料助理在对话里收集信息和资料，交接给政策匹配顾问，由其在对话里逐项解析、列出政策。只在已收录的官方公开政策内按用户所选内容筛选排序，没有实时检索；文件只记录名称，不读取内容。 */
(() => {
  'use strict';

  const questions = [
    { key: 'type', label: '企业类型', options: ['有限责任公司', '股份有限公司', '国有企业', '外商投资企业', '合伙企业', '个人独资企业', '个体工商户', '其他'] },
    { key: 'stage', label: '成长阶段', options: ['初创期（创业）', '成长期（成长）', '成熟期（做大做强）'] },
    { key: 'revenue', label: '营业收入', options: ['500万以下', '500-2000万', '2000-5000万', '5000万-1亿', '1-2亿', '2-5亿', '5-10亿', '10亿以上'] },
    { key: 'rd', label: '研发费占比', options: ['2%以下', '2%-3%', '3%-4%', '4%-5%', '5%-10%', '10%-15%', '15%以上'] },
    { key: 'talent', label: '近3年有无引进人才', options: ['无', '有'] },
  ];
  const groups = [
    { title: '基本信息', keys: ['type'] },
    { title: '经营情况', keys: ['stage', 'revenue'] },
    { title: '研发与人才', keys: ['rd', 'talent'] },
  ];
  const stageDelay = 1000;
  const state = { taskId: '', phase: 'result', stage: 0, timer: 0, drawerReturn: null };
  const companyInlineEditTasks = new Set();

  const S = () => window.PolicyStore;
  const esc = value => window.PolicyUI.escape(value);
  const icon = name => window.PolicyUI.icon(name);
  const labelOf = key => questions.find(question => question.key === key).label;
  const answersOf = task => task?.intake?.answers || {};
  const filesOf = task => task?.intake?.files || [];
  const answeredCount = answers => questions.filter(question => answers[question.key]).length;
  const revealedCount = answers => {
    const firstOpen = questions.findIndex(question => !answers[question.key]);
    return firstOpen < 0 ? questions.length : firstOpen + 1;
  };
  const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hintText = answers => {
    const left = questions.length - answeredCount(answers);
    return left ? `再选 ${left} 项，匹配更准` : '都选好了';
  };

  const publicPolicies = () => window.PolicyPublicPolicies || [];
  const pad = value => String(value).padStart(2, '0');
  const today = () => { const now = new Date(); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; };
  const shortDate = value => `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
  // 常态办理的事项（如软件产品增值税即征即退）没有申报窗口，按“政策方向”归类，不计入正在申报，但文案不说“暂未开放”。
  const ongoing = policy => policy?.category === '常态办理';
  const statusOf = policy => (!policy.applicationEnd ? 'notice' : policy.applicationEnd < today() ? 'closed' : 'open');
  const daysLeft = policy => Math.round((Date.parse(policy.applicationEnd) - Date.parse(today())) / 86400000);

  /* 置信度（PRD V2.2 8.2.2）：中标“以原文为准”，低显示“待确认”；低置信度的截止日期不算剩余天数，低置信度的办理入口不直接打开。 */
  const confOf = (policy, field) => policy?.confidence?.[field] || 'high';
  const confTag = level => level === 'mid' ? '<em class="conf-tag is-mid">以原文为准</em>' : level === 'low' ? '<em class="conf-tag is-low">待确认</em>' : '';
  function windowText(policy) {
    const status = statusOf(policy);
    if (status === 'notice') return ongoing(policy) ? '按纳税期常态办理' : '暂无统一申报窗口';
    if (status === 'closed') return `已于${shortDate(policy.applicationEnd)}截止`;
    if (policy.applicationStart > today()) return `${shortDate(policy.applicationStart)}开始申报`;
    const left = daysLeft(policy);
    return `${shortDate(policy.applicationEnd)}截止${left <= 7 ? `，${left ? `还剩 ${left} 天` : '今天截止'}` : ''}`;
  }

  /* 匹配依据只来自用户所选内容，不声称企业已满足政策条件。 */
  function matchPolicies(answers) {
    const { region, industry, stage, revenue, rd, talent } = answers;
    const rdLow = rd === '2%以下' || rd === '2%-3%';
    // 准入只有地区（PRD V2.2 8.1.4）：企业所在省、市或全国；地区待补充时只取全国政策。行业不筛选，作为计分条件。
    const hasRegion = Boolean(region) && region !== '其他地区';
    // 放宽到省时 region 是省名：再带上同省其他城市的政策，结果卡上提示申报前核对地区要求（PRD 6.3 第 6 条）。
    const inRegion = policy => policy.region === '全国' || (hasRegion && (policy.region === region || policy.region === regionParent[region] || regionParent[policy.region] === region));
    const reasonsFor = policy => {
      const rules = [
        region && policy.region === region && [3, `面向${region}，和你选的地区一致`],
        region && policy.region === '全国' && [1, '全国范围的政策'],
        industry && policy.industries.includes(industry) && [2, `${industry}在这项政策涉及的行业内`],
      ];
      if (policy.supportType === '研发支持') rules.push(
        rd && !rdLow && [2, `研发费占比 ${rd}，和研发支持方向相符`],
        rd && rdLow && [0, `研发费占比 ${rd}，研发投入要重点核对`],
        talent === '有' && [1, '近3年引进过人才，可作为研发能力的佐证'],
      );
      if (policy.supportType === '资质培育') rules.push(
        stage && !stage.startsWith('成熟') && [1, `处于${stage.slice(0, 3)}，可以核对培育条件`],
        rd && !rdLow && [1, `研发费占比 ${rd}，可作为资质材料的基础`],
      );
      if (policy.supportType === '数字化改造') rules.push(
        revenue && revenue !== '500万以下' && [1, `营业收入 ${revenue}，有条件开展数字化项目`],
      );
      if (policy.supportType === '金融支持') rules.push(
        stage && [1, `处于${stage.slice(0, 3)}，可以了解对应的金融服务`],
      );
      return rules.filter(Boolean);
    };
    const order = { open: 0, notice: 1, closed: 2 };
    return publicPolicies()
      .filter(policy => inRegion(policy))
      .map((policy, index) => {
        const matched = reasonsFor(policy);
        return { policy, index, status: statusOf(policy), score: matched.reduce((sum, [points]) => sum + points, 0), reasons: matched.map(([, reason]) => reason) };
      })
      .sort((a, b) => order[a.status] - order[b.status] || b.score - a.score || a.index - b.index);
  }

  /* ---------- 画像出来前的理解过程：只整理用户已给的信息，没有外部查询 ---------- */
  const understand = { taskId: '', stage: 0, timer: 0 };
  const understanding = taskId => understand.taskId === taskId;

  function understandStages(task) {
    const answers = answersOf(task), files = filesOf(task).length;
    const row = (label, value) => `<div class="match-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
    const stages = [
      { title: '读取企业名称', rows: row('企业名称', task.company.name) },
      { title: '整理你提供的信息', rows: row('所在地区', answers.region || '未填写') + row('企业资料', files ? `${files} 份` : '未提供') },
      { title: '生成企业画像', rows: row('下一步', '补充几项情况，画像会更完整') },
    ];
    return `<ol class="match-stages" data-understand aria-live="polite">${stages.map((stage, index) => `<li class="match-stage" data-stage="${index}"${index > understand.stage ? ' hidden' : ''} data-state="${index === understand.stage ? 'active' : 'done'}"><div class="match-stage-head"><h4>${esc(stage.title)}</h4><span class="match-stage-status" aria-hidden="true"></span></div><div class="match-stage-rows"><div>${stage.rows}</div></div></li>`).join('')}</ol>`;
  }

  function understandTick() {
    if (understand.stage >= 2) {
      Object.assign(understand, { taskId: '', stage: 0, timer: 0 });
      window.PolicyUI.refresh();
      return;
    }
    understand.stage += 1;
    document.querySelectorAll('[data-understand] .match-stage').forEach(node => {
      const index = Number(node.dataset.stage);
      node.hidden = index > understand.stage;
      node.dataset.state = index === understand.stage ? 'active' : 'done';
    });
    understand.timer = window.setTimeout(understandTick, stageDelay);
  }

  function beginPortrait(taskId) {
    window.clearTimeout(understand.timer);
    if (reducedMotion()) return;
    Object.assign(understand, { taskId, stage: 0, timer: window.setTimeout(understandTick, stageDelay) });
  }

  function portraitLoading(task) {
    return `<section class="context-card workspace-summary is-understanding"><header class="context-card-heading"><h2>企业画像</h2><span>理解中</span></header>${understandStages(task)}</section>`;
  }

  /* ---------- 对话里的资料收集 ---------- */
  const intakeActive = task => Boolean(task?.intake) && task.intake.stage !== 'ready';

  function assistantBubble(text, card = '', role = 'match') {
    const person = window.PolicyPersonas.get(role);
    return `<div class="chat-message-row is-assistant"><span class="chat-message-avatar chat-message-expert-avatar" aria-hidden="true" style="--portrait-x:${person.x}%;--portrait-y:${person.y}%"></span><div class="chat-message-body intake-body"><span class="chat-message-name">${esc(person.name)}</span>${card ? `<div class="chat-message chat-assistant has-card"><p class="chat-bubble-lead">${esc(text)}</p>${card}</div>` : `<p class="chat-message chat-assistant">${esc(text)}</p>`}</div></div>`;
  }

  function userBubble(text) {
    return `<div class="chat-message-row is-user"><span class="chat-message-avatar chat-message-user-avatar" aria-hidden="true">企</span><div class="chat-message-body"><span class="chat-message-name">企业负责人</span><p class="chat-message chat-user">${esc(text)}</p></div></div>`;
  }

  function questionFields(answers, revealed = revealedCount(answers)) {
    return questions.map((question, index) => `<fieldset class="intake-question${index === revealed - 1 && index ? ' is-new' : ''}" data-question="${index}"${index < revealed ? '' : ' hidden'}><legend>${esc(question.label)}</legend><div class="match-options">${question.options.map(option => `<label class="match-option"><input type="radio" name="${question.key}" value="${esc(option)}"${answers[question.key] === option ? ' checked' : ''}><span>${esc(option)}</span></label>`).join('')}</div></fieldset>`).join('');
  }

  /* 所属行业只在对话的字段卡里问；选项来自已收录政策。 */
  function industryField(answers) {
    const options = [...new Set(publicPolicies().flatMap(policy => policy.industries)), '其他行业'];
    return `<fieldset class="intake-question"><legend>所属行业</legend><div class="match-options">${options.map(option => `<label class="match-option"><input type="radio" name="industry" value="${esc(option)}"${answers.industry === option ? ' checked' : ''}><span>${esc(option)}</span></label>`).join('')}</div></fieldset>`;
  }

  function companyInlineEdit(task, location) {
    const answers = answersOf(task), facts = factsOf(task), id = esc(task.id);
    const region = answers.region || facts.region;
    const industry = answers.industry || facts.industry;
    const regionMarkup = regionField({ region }).replaceAll('name="region"', 'name="inline-region"');
    const industryMarkup = industryField({ industry }).replaceAll('name="industry"', 'name="inline-industry"');
    const form = `<div class="company-inline-edit intake-card" data-inline-location="${location}" data-task="${id}"><div class="intake-name-row"><label for="company-inline-name-${id}">企业名称</label><input id="company-inline-name-${id}" type="text" maxlength="300" autocomplete="organization" value="${esc(task.company.name)}"></div>${regionMarkup}${industryMarkup}<div class="intake-foot is-end"><button type="button" class="text-button" data-action="company-edit-cancel" data-task="${id}">取消</button><button type="button" class="button button-primary" data-action="company-edit-save" data-task="${id}">重新匹配</button></div></div>`;
    return form;
  }

  /* 点“确定”后先核对企业画像，确认了才匹配；点“跳过”直接按已有信息匹配。 */
  function confirmCard(task, stage) {
    const id = esc(task.id);
    if (stage === 'blocked') return assistantBubble(`「${task.company.name}」的工商状态为${esc(companyRevoked(task))}，不能进入匹配。`, `<div class="intake-card company-blocked" role="status"><p><strong>企业状态异常</strong>工商登记状态为“${esc(companyRevoked(task))}”。请核对企业名称是否填错，或换一家正常经营的企业。</p><div class="intake-foot is-end"><button type="button" class="button button-secondary" data-action="intake-edit" data-task="${id}">修改企业名称</button></div></div>`);
    const rows = portraitRows(task);
    const known = rows.filter(([, value]) => value).length;
    const notFound = companyNotFound(task) ? '<p class="confirm-note">没有查到工商信息，以下只有您填写的内容。</p>' : '';
    const regionPick = factsOf(task).region ? '' : `<div class="confirm-region">${regionField(answersOf(task))}<small>选所在地区，能看到地方政策；可以不选，不选只看全国政策。</small></div>`;
    return assistantBubble('请核对企业画像，确认后开始匹配。', `<div class="intake-card portrait-confirm"><header><strong>企业画像</strong><span>已了解 ${known}/${rows.length}</span></header>${notFound}<dl>${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd${value ? '' : ' class="is-empty"'}>${esc(value || '待补充')}</dd></div>`).join('')}</dl>${regionPick}<div class="intake-foot is-end"><button type="button" class="text-button" data-action="intake-edit" data-task="${id}">修改</button><button type="button" class="button button-primary" data-action="intake-confirm" data-task="${id}">确认企业信息，开始匹配 ${icon('arrow')}</button></div></div>`);
  }
  function fieldsCard(task) {
    const answers = answersOf(task), fields = questionFields(answers);
    return `<div class="intake-card intake-form" data-task="${esc(task.id)}"><div class="intake-name-row"><label for="intake-name">企业名称</label><input id="intake-name" type="text" maxlength="300" autocomplete="organization" data-task="${esc(task.id)}" value="${esc(task.company.name)}"></div>${fields}<div class="intake-foot"><p class="match-hint" aria-live="polite">${esc(hintText(answers))}</p><div class="intake-foot-actions"><button type="button" class="button button-primary" data-action="intake-start" data-task="${esc(task.id)}">确定 ${icon('arrow')}</button></div></div></div>`;
  }

  /* 输入框里的上传入口和已选文件，资料助理对话的任何阶段都能用。 */
  function composerAttach(task, showList = true) {
    const files = filesOf(task);
    const list = files.length && showList ? `<ul class="intake-files">${files.map(file => `<li><span>${esc(file.name)}</span><small>已上传</small><button type="button" class="text-button" data-action="intake-remove-file" data-task="${esc(task.id)}" data-file="${esc(file.id)}" aria-label="移除${esc(file.name)}">移除</button></li>`).join('')}</ul>` : '';
    return `${list}<label class="intake-attach" for="intake-files" title="上传资料"><input id="intake-files" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png" data-task="${esc(task.id)}">${icon('clip')}<span class="sr-only">上传企业资料</span></label>`;
  }

  function answersSummary(answers) {
    return questions.filter(question => answers[question.key]).map(question => answers[question.key]).join(' · ') || '先不填，直接往下';
  }

  function intakeMarkup(task) {
    if (!task?.intake) return '';
    if (understanding(task.id)) return assistantBubble(`收到，我先理解一下「${task.company.name}」的情况。`, `<div class="intake-card match-running"><div class="match-running-body"><div class="match-orb" aria-hidden="true"><span class="match-orb-ring"></span><span class="match-orb-ring"></span><span class="match-orb-core">正在理解</span></div>${understandStages(task)}</div></div>`);
    const answers = answersOf(task), { stage } = task.intake;
    const greeting = `想帮「${task.company.name}」匹配政策，先了解几项情况，点选就行。`;
    if (stage === 'fields') return assistantBubble(greeting, fieldsCard(task));
    if (stage === 'confirm' || stage === 'blocked') return `${assistantBubble(greeting)}${userBubble(answersSummary(answers))}${confirmCard(task, stage)}`;
    const edit = `<button type="button" class="text-button intake-edit" data-action="intake-edit" data-task="${esc(task.id)}">修改</button>`;
    const history = `${assistantBubble(greeting)}${userBubble(answersSummary(answers))}${edit}`;
    const count = filesOf(task).length;
    return `${history}${count ? userBubble(`选了 ${count} 份企业资料`) : ''}${assistantBubble('结果可以随时回看。想补充信息或资料，点上面的修改。', `<div class="intake-foot intake-ready"><button type="button" class="button button-primary" data-task="${esc(task.id)}" data-action="intake-result">查看匹配结果 ${icon('arrow')}</button></div>`)}`;
  }

  /* ---------- 按所选政策生成准备清单 ---------- */
  function applicationPatch(task, policy) {
    const sources = [...task.sources];
    const statusOf_ = sourceId => sources.find(source => source.id === sourceId)?.provided ? 'ready' : 'missing';
    const items = policy?.application?.checklist;
    if (items) {
      // 资格条件不进材料清单：在政策解读里提示，不拦截。
      const requirements = items.filter(item => item.kind !== 'condition').map(item => {
        const id = `${policy.id}-${item.id}`;
        if (!sources.some(source => source.id === id)) sources.push({ id, name: item.label, type: 'document', text: '', provided: false });
        return { id, label: item.label, status: statusOf_(id), kind: 'material', evidence: item.note, sourceId: id, action: '', required: item.required !== false };
      });
      return { sources, requirements };
    }
    // 原文没有列清单：回到常用资料。
    const common = window.PolicyData.createTaskSeed({}).requirements.map(item => ({ ...item, status: statusOf_(item.sourceId) }));
    return { sources, requirements: common };
  }

  function chooseStep(task, policy) {
    const changed = task.policyId !== policy.id;
    return { policyId: policy.id, status: 'processing', ...(changed ? applicationPatch(task, policy) : {}), steps: changed ? { match: true, diagnosis: false, assembly: false, review: false } : { match: true } };
  }

  /* 材料清单先说明政策依据；办理渠道另放办理指引。 */
  function applicationIntro(task) {
    const policy = publicPolicies().find(item => item.id === task.policyId);
    if (!policy) return '';
    const app = policy.application;
    const source = `<a href="${esc(policy.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(/^《/.test(policy.title) ? policy.title : `《${policy.title}》`)}</a>`;
    const downloads = (app?.templates || []).filter(item => /\.(zip|docx?|pdf)(?:[?#]|$)/i.test(item.url));
    // 模板不在原文附件里时（比如要在官方系统里下载），按库表里的说明提示去哪里取。
    const missing = app?.templateStatus === 'missing' ? `<p class="template-missing">这项政策有申报模板，但暂未收录。${app.templateWhere ? esc(app.templateWhere) : `可以从${source}的附件下载`}后上传，上传后照常整理材料。</p>` : '';
    return `<div class="chat-gap-templates">${missing}<p>${app ? `根据${source}，需要准备以下材料：` : `${source}未列出具体材料清单，以下为常用资料，待按原文核对。`}</p>${downloads.length ? '官方模板：' : ''}${downloads.map(item => `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.label)}</a>`).join('、')}</div>`;
  }

  /* 官方系统相关的说明和指南链接，都放在提交抽屉里。 */
  function applicationGuidance(policy) {
    const app = policy?.application;
    if (!app?.templateNote && !app?.templates?.length) return '';
    return `<p>${esc(app.templateNote || '')}</p>${(app.templates || []).map(item => `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.label)}</a>`).join('')}`;
  }

  function applicationNote(task, item) {
    return publicPolicies().find(policy => policy.id === task.policyId)?.application?.checklist.find(entry => `${task.policyId}-${entry.id}` === item.id)?.note || '';
  }

  /* ---------- 办理指引：对话里是步骤，点开在右侧抽屉看详情；提交由用户本人完成 ---------- */
  const latestVersion = task => S().getState().versions.filter(version => version.taskId === task.id).sort((a, b) => b.number - a.number)[0];

  function guidanceMarkup(task) {
    const policy = task.steps.match ? window.PolicyData.policies.find(item => item.id === task.policyId && !item.noPolicy) : null;
    if (!policy) return '';
    const open = publicPolicies().find(item => item.id === policy.id);
    const latest = latestVersion(task);
    const submit = open?.application?.submit;
    const deadline = submit?.deadline || (open ? windowText(open) : policy.deadline);
    // 常态办理的事项没有统一截止日期（如“按纳税期办理”），不再拼“截止”。
    const dueText = confOf(open, 'applicationEnd') === 'low' ? '截止时间待确认' : /\d/.test(deadline) ? `${deadline}截止` : deadline;
    const scored = open ? policyScore(task, open) : null;
    if (hasNoTemplate(open)) {
      const items = open.application.checklist.filter(item => item.kind !== 'condition');
      const row = `<ol class="guidance-list"><li><button type="button" class="guidance-step" data-route="guidance" data-task="${esc(task.id)}" data-work="guidance"><span class="guidance-step-number">1</span><span class="guidance-step-copy"><strong>材料清单和办理步骤</strong><small>共 ${items.length} 项材料，${esc(submit.name)}，${esc(dueText)}</small></span>${icon('arrow')}</button></li></ol>`;
      return assistantBubble('这项政策没有申报模板，不生成初稿。按材料清单准备后，到官方系统办理。', row, 'guidance');
    }
    const rows = [
      // V2.3：从“核对并提交”进来的任务，材料核对结果在上面的核对卡里，这一步直接引用它。
      task.entry === 'guidance' && !latest ? (() => { const rows = materialCheck(task, open || policy).filter(row => row.required); const ok = rows.filter(row => row.state !== 'lack').length; const warn = rows.filter(row => row.state === 'warn').length; return { title: '核对申报材料', detail: `已齐 ${ok}/${rows.length} 项${warn ? `，${warn} 项有问题` : ''}`, attrs: 'data-action="guidance-prep"', work: 'guidance', state: ok === rows.length && !warn ? '已核对' : '待补齐' }; })() :
      { title: '检查申报材料', detail: !latest ? '还没有申报材料' : scored ? `V${latest.number}，材料准备度 ${scored.ready}/${scored.total}` : `V${latest.number}，点开查看全部内容`, attrs: latest ? `data-route="version" data-id="${esc(latest.id)}"` : 'data-action="guidance-prep"', work: latest ? 'guidance' : 'assembly', state: !latest ? '待整理' : latest.status === 'confirmed' ? '已确认' : '待确认', done: latest?.status === 'confirmed' },
      { title: submit?.email ? '发邮件报送' : '到官方系统提交', detail: submit ? `${submit.name}，${dueText}` : '按政策指定的官方渠道办理', attrs: 'data-route="guidance"', state: '' },
    ];
    const card = `<ol class="guidance-list">${rows.map((row, index) => `<li><button type="button" class="guidance-step" ${row.attrs} data-task="${esc(task.id)}" data-work="${row.work || 'guidance'}"><span class="guidance-step-number">${index + 1}</span><span class="guidance-step-copy"><strong>${esc(row.title)}</strong><small>${esc(row.detail)}</small></span>${row.state ? `<span class="guidance-step-state${row.done ? ' is-done' : ''}">${esc(row.state)}</span>` : ''}${icon('arrow')}</button></li>`).join('')}</ol>`;
    return assistantBubble(`接下来这样办，点开每一步看详情。`, card, 'guidance');
  }

  /* 申报辅助里选到没有模板的政策：不生成初稿，转到办理指引。 */
  function noTemplateNotice(task) {
    const policy = publicPolicies().find(item => item.id === task.policyId);
    if (!task.steps.match || !hasNoTemplate(policy)) return '';
    return assistantBubble('这项政策没有申报模板，不生成初稿。材料清单和办理步骤都在办理指引里。', `<div class="intake-foot is-end prep-no-template"><button type="button" class="button button-primary" data-route="task" data-task="${esc(task.id)}" data-work="guidance">查看办理指引 ${icon('arrow')}</button></div>`, 'assembly');
  }

  /* 打开材料时按这版内容重新估一次成功率。 */
  function versionReview(task, version) {
    const policy = task?.policyId === version.policyId ? publicPolicies().find(item => item.id === version.policyId) : null;
    const result = policy && policyScore(task, policy);
    if (!result) return '';
    const rows=comparisonRows(task,policy), n=rows.filter(row=>row.key!=='materials'&&row.status!=='ready').length;
    const level=result.level, note=n?`${n} 项可能不符或未知`:'条件都符合';
    const hasCompany=Boolean(task?.company?.name);
    const score=`<div class="vd-score"><span>匹配度</span><strong>${hasCompany?esc(level):'—'}</strong></div>`;
    const compare=hasCompany?`<small>${esc(note)}</small><button type="button" class="text-button" data-action="match-drawer" data-task="${esc(task.id)}" data-policy="${esc(policy.id)}" data-from="recheck">查看对照</button>`:'<small>未填企业名称，无法判断匹配度</small>';
    return `<section class="drawer-summary version-review vd-summary"><div class="vd-score"><span>材料准备度</span><strong>${result.ready}<small>/${result.total}</small></strong></div>${score}<div class="vd-summary-text"><p>按这版材料重新核对</p><small>已备 ${result.ready}/${result.total} 项必传材料</small>${compare}<small>仅供参考，最终以主管部门审核为准。</small></div></section>`;
  }

  function scoreLine(task, policy, { from } = {}) {
    if (!task?.company?.name) return '<div class="check-score is-empty"><span class="check-score-label">匹配度</span><span class="check-score-note">未填企业名称，无法判断匹配度</span></div>';
    const result=policyScore(task,policy);
    const n=comparisonRows(task,policy).filter(row=>row.key!=='materials'&&row.status!=='ready').length;
    const note=n?`${n} 项可能不符或未知`:'条件都符合';
    return `<div class="check-score"><span class="check-score-label">匹配度</span><strong class="check-score-level is-${esc(result?.level||'其他')}">${esc(result?.level||'其他')}</strong><span class="check-score-note">${esc(note)}</span><button type="button" class="text-button" data-action="match-drawer" data-task="${esc(task.id)}" data-policy="${esc(policy.id)}" data-from="${esc(from||'recheck')}">查看对照</button></div>`;
  }

  /* 抽屉里的提交详情；没有整理过的政策沿用原来的办理页。 */
  /* 前往官方系统：先二次确认，同一政策确认过就不再问；每次都记一条事件。 */
  const jumpKey = 'huiqi-official-jumps-v23';
  const confirmedJumps = new Set();
  /* V2.3 顶部步骤用：这个任务选了哪条政策、匹配度、材料准备到几项、截止时间、最近一次前往官方系统。 */
  function stepInfo(task) {
    const open = task?.steps?.match && task.policyId !== 'no-policy' ? publicPolicies().find(item => item.id === task.policyId) : null;
    if (!open) return { hasPolicy: false };
    const items = (open.application?.checklist || []).filter(item => item.kind !== 'condition' && item.required !== false);
    const ready = items.filter(item => task.sources?.some(source => source.id === `${open.id}-${item.id}` && source.provided)).length;
    const last = jumpEvents().filter(item => item.taskId === task.id && item.policyId === open.id).at(-1);
    const date = last ? new Date(last.at) : null;
    return { hasPolicy: true, title: open.title, level: policyScore(task, open)?.level || '', ready, total: items.length, status: statusOf(open), due: windowText(open), jumped: date ? `${date.getMonth() + 1}月${date.getDate()}日` : '' };
  }
  function jumpEvents() { try { return JSON.parse(localStorage.getItem(jumpKey) || '[]'); } catch { return []; } }
  function recordJump(link) {
    const events = jumpEvents();
    events.push({ taskId: link.dataset.task, policyId: link.dataset.policy, platform: link.dataset.name, url: link.href, source: 'guidance', at: new Date().toISOString() });
    try { localStorage.setItem(jumpKey, JSON.stringify(events.slice(-200))); } catch {}
  }
  function jumpLog(taskId, policyId) {
    const last = jumpEvents().filter(item => item.taskId === taskId && item.policyId === policyId).at(-1);
    if (!last) return '';
    const date = new Date(last.at);
    return `<p class="guidance-jump-log">已于 ${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())} ${/^mailto:/.test(last.url || '') ? '打开邮件准备报送' : '前往官方系统'}</p>`;
  }
  function goOfficial(link) {
    if (!link.hasAttribute('data-official-jump')) { window.open(link.href, '_blank', 'noopener'); return; }
    confirmedJumps.add(link.dataset.policy);
    recordJump(link);
    window.open(link.href, '_blank', 'noopener');
    window.PolicyUI.refresh();
  }
  const leaveHost = link => { try { return `（${new URL(link.href).hostname}）`; } catch { return ''; } };
  function closeLeaveDialog() { document.querySelector('#leave-dialog')?.remove(); }
  function openLeaveDialog(link) {
    closeLeaveDialog();
    const dialog = document.createElement('div');
    dialog.id = 'leave-dialog';
    dialog.className = 'leave-dialog';
    dialog.innerHTML = `<button type="button" class="leave-dialog-scrim" data-leave="cancel" aria-label="取消" tabindex="-1"></button><section role="dialog" aria-modal="true" aria-labelledby="leave-title"><h2 id="leave-title">即将离开本产品</h2><p>${link.hasAttribute('data-official-jump') ? `即将前往${esc(link.dataset.name)}办理，申报与审核以该平台为准。` : `即将打开外部网页${esc(leaveHost(link))}，内容以该网站为准。`}</p><div class="leave-dialog-actions"><button type="button" class="button button-secondary" data-leave="cancel">取消</button><button type="button" class="button button-primary" data-leave="go">继续前往 ${icon('arrow')}</button></div></section>`;
    document.body.append(dialog);
    dialog.addEventListener('click', event => {
      const action = event.target instanceof Element ? event.target.closest('[data-leave]')?.dataset.leave : '';
      if (!action) return;
      closeLeaveDialog();
      if (action === 'go') goOfficial(link); else link.focus({ preventScroll: true });
    });
    dialog.querySelector('[data-leave="go"]').focus({ preventScroll: true });
  }
  document.addEventListener('click', event => {
    // V2.2：所有离开本产品的链接（官方系统、政策原文、模板、外部服务）每次点击都二次确认，不做静默跳转。
    const link = event.target instanceof Element ? event.target.closest('a[data-official-jump], a[href^="http"]') : null;
    if (!link || link.closest('#leave-dialog') || new URL(link.href, location.href).origin === location.origin) return;
    event.preventDefault();
    openLeaveDialog(link);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeLeaveDialog(); });

  function guidanceDetail(task) {
    const policy = task.steps.match ? publicPolicies().find(item => item.id === task.policyId) : null;
    if (!policy) return '';
    const submit = policy.application?.submit;
    // 邮件报送的政策（submit.email）：按发邮件的说法写，复制的是邮箱地址。
    const mail = Boolean(submit?.email);
    const lowDate = confOf(policy, 'applicationEnd') === 'low', lowUrl = confOf(policy, 'submitUrl') === 'low';
    const left = statusOf(policy) === 'open' && !lowDate ? daysLeft(policy) : null;
    const facts = [['截止时间', lowDate ? '待确认，以原文为准' : submit?.deadline || windowText(policy)], ...(left !== null ? [['还剩', `${left} 天`]] : []), ...(submit?.contact ? [['咨询', submit.contact]] : [])];
    const steps = [
      lowUrl ? { title: '确认办理渠道', detail: '办理入口还没核实，请先看政策原文写明的渠道', action: `<a class="button button-secondary" href="${esc(policy.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看原文中的办理渠道 ${icon('arrow')}</a>` } : { title: mail ? '发邮件报送' : '打开官方系统', detail: submit ? (mail ? `${submit.name}：${submit.email}` : submit.name) : '按原文写明的渠道办理', action: `<a class="button button-primary" href="${esc(submit?.url || policy.sourceUrl)}" target="_blank" rel="noopener noreferrer" data-official-jump data-task="${esc(task.id)}" data-policy="${esc(policy.id)}" data-name="${esc(submit?.name || policy.agency)}">${mail ? '写邮件' : submit ? '打开系统' : '查看原文'} ${icon('arrow')}</a>` },
      ...(submit ? submit.steps : []).map(step => ({ title: step })),
      mail ? { title: '保存发送记录', detail: '发送后保留已发送的邮件和附件，以便后续查询。' } : { title: '保存回执', detail: '提交后保存系统的回执，以便后续查询。' },
    ];
    return `<div class="guidance-detail"><h2 class="sr-only">${mail ? '发邮件报送' : '到官方系统提交'}</h2><section class="drawer-summary guidance-summary"><p>${esc(policy.title)}</p><dl>${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></section>${hasNoTemplate(policy) ? `<section class="guidance-materials"><h3>材料清单</h3><p>这项政策没有申报模板，不生成初稿，按清单准备。</p><ul>${policy.application.checklist.filter(item => item.kind !== 'condition').map(item => `<li><strong>${esc(item.label)}${confTag(item.confidence)}</strong>${item.note ? `<small>${esc(item.note)}</small>` : ''}</li>`).join('')}</ul></section>` : ''}<ol class="guidance-timeline">${steps.map(step => `<li${step.detail ? '' : ' class="is-plain"'}><div><strong>${esc(step.title)}</strong>${step.detail ? `<small>${esc(step.detail)}</small>` : ''}</div>${step.action || ''}</li>`).join('')}</ol>${jumpLog(task.id, policy.id)}<p class="guidance-note">${mail ? '邮件要你本人从单位邮箱发送。' : '登录和提交要你本人在官方系统完成。'}</p>${applicationGuidance(policy) ? `<div class="guidance-policy-note">${applicationGuidance(policy)}</div>` : ''}<div class="guidance-fallback"><span>${mail ? '邮件程序打不开？' : '官方系统打不开？'}</span><button type="button" class="text-button" data-action="copy-official" data-url="${esc(mail ? submit.email : submit?.url || policy.sourceUrl)}">${mail ? '复制邮箱地址' : '复制官方链接'}</button><button type="button" class="text-button" data-action="guidance-service">联系人工客服</button></div></div>` + (jumpEvents().some(item => item.taskId === task.id && item.policyId === policy.id) ? '' : serviceRec('handling'));
  }

  /* 公开政策的详情：和政策列表用同一张结构化卡片。 */
  function policyDetail(task, policyId) {
    const policy = publicPolicies().find(item => item.id === policyId);
    if (!policy) return '';
    const matched = matchPolicies(factsOf(task)).find(item => item.policy.id === policyId);
    return `<div class="match-drawer-body-inline">${policyCard(task, { policy, status: statusOf(policy), reasons: matched?.reasons || [] }, false)}</div>`;
  }

  /* ---------- 政策解读：在对话里选政策、看解读 ---------- */
  const factsOf = task => {
    const answers = answersOf(task);
    return { ...answers, region: answers.region || task.company.region, industry: answers.industry || task.company.industry };
  };

  /* 按画像排序；画像对不上任何政策时列出全部，解读不要求企业符合条件。 */
  function interpretMatches(task) {
    const matched = matchPolicies(factsOf(task));
    return matched.length ? matched : matchPolicies({});
  }

  const interpretId = task => task.interpretPolicyId || '';
  const interpretingPublic = task => publicPolicies().find(policy => policy.id === interpretId(task));
  // 选的是内置项目自带的政策时，沿用原来的对话内容。
  const interpretActive = task => !interpretId(task) || Boolean(interpretingPublic(task));

  /* 匹配度（PRD V2.2 8.1.4，2026-11-10 和业务对齐）：准入条件（地区、行业）只过滤，未知不过滤、标待确认；
     其余每项条件权重相同，满足一项得一项，内部分值 = 满足数 ÷ 总数 × 100（未知算不满足、计入总数）；
     只向用户展示高 / 中 / 低：80 及以上为高，20 以下为低，其余为中；全部未知显示“待确认”。材料只算准备度，不计分。 */
  const HIGH_LINE = 80, LOW_LINE = 20;
  const FIRST_PICK_MIN = HIGH_LINE;  // 首选推荐：第一条正在申报且匹配度为高
  const GAP_LINE = LOW_LINE;         // 匹配度为低时提示“条件差距较大”
  // V2.2 最终口径：4 档 高 / 中 / 暂无法判断 / 低；一项都判断不了时为“暂无法判断”。
  const gradeOf = score => score === null ? '暂无法判断' : score >= HIGH_LINE ? '高' : score < LOW_LINE ? '低' : '中';
  const GRADE_ORDER = { 高: 0, 中: 1, 暂无法判断: 2, 低: 3 };
  const GRADE_TIPS = { 高: '大部分条件已经满足', 中: '部分条件满足，补充或补齐后可能更高', 低: '条件差距较大，建议先补齐再申报', 暂无法判断: '现有信息判断不了，补充企业信息后可以判断' };
  const STATE_TIPS = { 符合: '企业信息达到这项要求', 可能不符: '按现有信息还没达到，信息有误可以修改', 待补充: '缺企业信息，补充后就能判断', 待确认: '政策原文对这项要求写得不够明确，以原文为准' };
  const helpTip = text => `<span class="help-tip" tabindex="0" role="img" aria-label="${esc(text)}" data-tip="${esc(text)}">?</span>`;
  const isScored = row => row.kind === '计分条件' || row.kind === '量化条件';
  function scoreOf(rows) {
    const gate = rows.filter(row => row.kind === '准入条件'), metrics = rows.filter(isScored);
    const blocked = gate.some(row => row.status === 'missing');
    // 待补充（企业信息缺）、待确认（政策置信度低）都按不满足算，仍计入总数；没有计分条件记 60 分。
    const met = metrics.filter(row => row.status === 'ready').length;
    const judged = metrics.filter(row => row.status === 'ready' || row.status === 'missing').length;
    const score = !metrics.length ? 60 : judged ? Math.round(met / metrics.length * 100) : null;
    const pending = metrics.filter(row => row.status === 'unknown').length;
    const grade = gradeOf(score);
    const level = blocked ? '准入不符' : grade;
    return { score, shown: score, grade, level, pending, blocked };
  }
  function comparisonRows(task, policy) {
    const { region, industry } = factsOf(task);
    const metrics = policyMetrics(task, policy);
    const items = (policy.application?.checklist || []).filter(item => item.kind !== 'condition' && item.required !== false);
    const ready = items.filter(item => task.sources?.some(source => source.id === `${policy.id}-${item.id}` && source.provided)).length;
    const row = (key, label, required, current, max, ratio, action) => ({key,label,required,current,max,points:ratio===null?null:Math.round(max*Math.min(1,Math.max(0,ratio))),status:ratio===null?'unknown':ratio>=1?'ready':'missing',action});
    const rows = [
      row('region','适用地区',policy.region,region||(policy.region==='全国'?'不限地区':'待补充'),15,policy.region==='全国'?1:!region?null:region===policy.region?1:0,'核对地区'),
      ...(policy.industries.length?[row('industry','所属行业',policy.industries.join('、'),industry||'待补充',15,!industry?null:policy.industries.includes(industry)?1:0,'核对行业')]:[]),
      ...metrics.map((item,index)=>({...row(item.key,item.label,`≥ ${item.need}${item.unit==='%'?'':' '}${item.unit}`,item.interval?item.display:item.have===null?'待核实':`${item.have} ${item.unit}`,Math.floor(30/metrics.length)+(index===0?30%metrics.length:0),item.have===null?null:item.have/item.need,'核对数量'),metric:item})),
      {...row('materials','申报材料',items.length?`${items.length} 项必需材料`:'清单待核实',`${ready} 项已上传`,metrics.length?40:70,items.length?ready/items.length:null,'补充材料'),ready,total:items.length},
    ];
    rows.forEach(row => { row.kind = row.key === 'region' ? '准入条件' : row.key === 'industry' ? '计分条件' : row.key === 'materials' ? '材料（不计入匹配度）' : '量化条件'; });
    // 政策这一项置信度低：记“待确认”，按不满足算（PRD 8.2.2）。
    rows.forEach(row => { if (row.metric && policy.confidence?.metrics?.[row.key] === 'low') row.status = 'tbc'; });
    return rows;
  }
  function policyScore(task, policy) {
    if (!task?.id) return null;
    const rows=comparisonRows(task,policy),materials=rows.find(row=>row.key==='materials');
    return {...scoreOf(rows),rows,ready:materials.ready,total:materials.total,known:questions.filter(question=>answersOf(task)[question.key]).length,knownTotal:questions.length};
  }

  /* 正在申报且匹配度为低时只提示，不拦截。 */
  const suggestPause = (result, policy) => Boolean(result) && result.score !== null && result.score < GAP_LINE && statusOf(policy) === 'open';
  const pauseTag = '<em class="policy-pause">条件差距较大，建议先补齐</em>';

  /* 预估补贴：只用政策写明的金额或上限，没写的不估算，显示“以原文为准”。 */
  function subsidyStat(policy) {
    const s = policy.subsidy;
    return s ? `<span class="policy-stat policy-subsidy"><strong>${s.prefix ? `<small class="policy-stat-prefix">${esc(s.prefix)}</small>` : ''}${esc(s.value)}<small>${esc(s.unit)}</small></strong><small>预估补贴${confOf(policy, 'subsidy') === 'mid' ? ' · 以原文为准' : ''}</small></span>` : `<span class="policy-stat policy-subsidy is-text"><strong>以原文为准</strong><small>预估补贴</small></span>`;
  }
  const industryMiss = (task, policy) => { const industry = factsOf(task).industry; return industry && policy.industries.length && !policy.industries.includes(industry) ? industry : ''; };
  function scoreBadge(task, policy) {
    const result = policyScore(task, policy);
    const miss = industryMiss(task, policy);
    // 差距提示：行业不符优先于其他提示。
    const tag = miss ? `<em class="policy-pause is-card">政策支持的行业不含${esc(miss)}，申报前核对</em>` : suggestPause(result, policy) ? '<em class="policy-pause is-card">条件差距较大，建议先补齐</em>' : result?.grade === '暂无法判断' && statusOf(policy) === 'open' ? '<em class="policy-pause is-card is-pending">补充企业信息后可以判断</em>' : '';
    return `<span class="policy-stats">${result ? scoreStat(result, policy, false) : ''}${subsidyStat(policy)}</span>${tag}`;
  }
  function scoreStat(result, policy, withPause = true) {
    return result ? `<span class="policy-stat policy-score is-grade is-${{ 高: 'high', 中: 'mid', 低: 'low', 暂无法判断: 'pending' }[result.level] || 'text'}"><strong>${result.level}</strong><small>匹配度${GRADE_TIPS[result.level] ? helpTip(GRADE_TIPS[result.level]) : ''}</small>${withPause && suggestPause(result, policy) ? pauseTag : ''}</span>` : '';
  }

  function scoreText(task, policy) {
    const result = policy && policyScore(task, policy);
    if (!result) return '告诉我企业名称和情况，我才能判断匹配度。';
    return `本产品不估算获批概率。按现在的信息，「${policy.title}」的匹配度是${result.level}${result.pending ? `，还有 ${result.pending} 项待补充，补充后更准` : ''}${task.policyId === policy.id ? `；材料准备度 ${result.ready}/${result.total}` : ''}。${(ongoing(policy) ? { notice: '这项政策按纳税期常态办理，不是集中申报。' } : { open: '', notice: '这项政策暂未开放申报，开放后再来申报。', closed: '这项政策已截止，本期无法申报。' })[statusOf(policy)] || ''}最终以主管部门审核为准。`;
  }

  function scorePanel(task, policy) {
    const status = statusOf(policy);
    const result = policyScore(task, policy);
    return `<div class="interpret-score"><div class="score-orb${result ? '' : ' is-empty'}">${result ? `<strong>${result.level}</strong>` : '<strong>--</strong>'}<span>匹配度</span></div><p>${status === 'open' ? '' : status === 'closed' ? '这项政策已截止。' : '这项政策暂无申报窗口。'}${result ? '按现在的信息和资料估算，最终以主管部门审核为准。' : '告诉我企业情况和资料，我来估算。'}</p></div>`;
  }

  const viewButton = (task, policy) => `<button type="button" class="text-button match-policy-view" data-action="match-drawer" data-task="${esc(task.id)}" data-policy="${esc(policy.id)}">查看 ${icon('chevron')}</button>`;

  function interpretPicker(task) {
    const matches = interpretMatches(task);
    const hasFacts = factsOf(task).region || factsOf(task).industry;
    const guide = hasFacts ? '' : `<div class="interpret-guide"><p>告诉我企业名称和情况，可以判断匹配度。</p>${task.id ? `<button type="button" class="text-button" data-action="portrait-edit" data-task="${esc(task.id)}">补充企业信息</button>` : '<button type="button" class="text-button" data-action="home-start-expert" data-work="profile">补充企业信息</button>'}</div>`;
    const cards = matches.map(({ policy, status }) => `<article class="match-policy is-compact is-clickable is-${status}${policyScore(task, policy) ? ' has-score' : ''}">${scoreBadge(task, policy)}<p class="match-policy-tag">${{ open: '正在申报', notice: '政策方向', closed: '已截止' }[status]}</p><h3><button type="button" class="match-policy-open" data-action="match-drawer" data-task="${esc(task.id)}" data-policy="${esc(policy.id)}">${esc(policy.title)}</button></h3><p class="match-policy-meta">${esc(policy.region)} · ${esc(windowText(policy))}</p>${viewButton(task, policy)}</article>`).join('');
    return assistantBubble('想了解哪项政策？选一项，我来讲清楚。', `<div class="intake-card match-result${onlyOpen ? ' only-open' : ''}"><div class="match-result-bar">${onlyOpenToggle()}</div>${guide}<div class="match-policy-grid">${cards}</div></div>`, 'match');
  }

  /* 数值门槛只用政策原文写明的（public-policy-data.js 里的 metrics），原文没写就不判断。 */
  const policyRules = policy => policy?.metrics || [];
  /* 企业接口：原型还没接集团企业地图接口，这里只收录核对过公开来源的真实企业（来源见 public-policy-sources.md）。
     不在名单里的企业按“查不到工商信息”处理；没核实到的字段留空，画像里显示“待补充 / 待核实”。 */
  const REAL_COMPANIES = {
    北京久其金建科技有限公司: { region: '北京市', industry: '软件信息', founded: '2017-04-13' },
    北京华夏电通科技股份有限公司: { region: '北京市', industry: '软件信息', founded: '2001-09-14' },
    北京久其政务软件股份有限公司: { region: '北京市', industry: '软件信息', founded: '2006-01-12' },
    上海久其软件有限公司: { region: '上海市', industry: '软件信息' },
    成都久其软件有限公司: { region: '成都市', industry: '软件信息' },
    广东久其软件有限公司: { region: '广州市', industry: '软件信息' },
  };
  /* 工商状态为注销、吊销：按“查不到企业”处理（PRD 6.3 第 2 条）。华宇信码 2026-06-29 完成注销登记。 */
  const REVOKED_NAMES = { 北京华宇信码技术有限公司: '注销' };
  const sim = key => Boolean(window.PolicySim?.on(key));
  const companyKey = task => (task?.company?.name || '').trim();
  // 企业接口失败或超时（模拟开关）：不提示核对名称，提示稍后重试。
  const companyApiFailed = task => Boolean(companyKey(task)) && sim('apiTimeout');
  const companyNotFound = task => { const name = companyKey(task); return Boolean(name) && (companyApiFailed(task) || !REAL_COMPANIES[name] || Boolean(REVOKED_NAMES[name])); };
  const companyRevoked = task => REVOKED_NAMES[companyKey(task)] || '';
  /* 经营风险：没有找到可公开核验的真实记录，只能用模拟开关演示，记录上写明是模拟的。 */
  const companyRisks = task => sim('risk') && !companyNotFound(task) ? [['经营异常（模拟）', '1 条，列入原因：通过登记的住所无法联系。这条记录由模拟开关生成，不是该企业的真实记录']] : [];
  function diagnosisCard(task) {
    if (companyNotFound(task)) return '';
    // 只在查到风险时出现；没有风险的企业不打扰。
    const risks = companyRisks(task);
    if (!risks.length) return '';
    const riskRows = risks.map(([label, detail]) => `<li class="is-risk"><b>${esc(label)}</b>${esc(detail)}</li>`).join('');
    return `<section class="diag-card" aria-labelledby="diag-title"><header><h3 id="diag-title">发现 ${risks.length} 项经营风险，可能影响申报</h3><small>来源：模拟开关</small></header><ul>${riskRows}</ul>${serviceRec('risk')}</section>`;
  }
  function apiProfile(name) {
    const key = (name || '').trim(), company = REAL_COMPANIES[key];
    if (!key || !company || REVOKED_NAMES[key] || sim('apiTimeout')) return { region: '', industry: '' };
    return { region: company.region, industry: company.industry };
  }
  const notFoundNotice = task => companyApiFailed(task) ? `<div class="company-notfound" role="status"><p><strong>企业信息暂时查询失败，请稍后重试。</strong>下面的结果只按您填写的信息匹配。</p><button type="button" class="text-button" data-action="company-retry" data-task="${esc(task.id)}">重试</button></div>` : companyNotFound(task) ? `<div class="company-notfound" role="status"><p><strong>没有查到「${esc(task.company.name)}」的工商信息。</strong>请核对企业全称是否和营业执照一致。下面的结果只按您填写的信息匹配，信息还不完整，补充专利、软著等信息后结果更准。</p><button type="button" class="text-button" data-action="company-edit-inline" data-task="${esc(task.id)}">修改企业名称或补充信息</button></div>` : '';
  function mockCompanyData(task) {
    const name = task?.company?.name;
    if (!name) return null;
    // 专利、软著数量还没有核实到公开来源，接口一律不给，用户可以自己补充。
    const defaults={patents:null,copyrights:null};
    const answers=answersOf(task);
    return Object.fromEntries(Object.entries(defaults).map(([key,value])=>{
      const field=`metric_${key}`;
      if(!Object.hasOwn(answers,field))return [key,value];
      const n=Number(answers[field]);
      return [key,answers[field]!==''&&Number.isInteger(n)&&n>=0&&n<=1000000?n:null];
    }));
  }
  /* 画像固定 12 项，右侧画像卡和确认卡用同一份，“已了解 X/12”的分母不变。 */
  const PORTRAIT_LABELS = ['企业名称', '所在地区', '所属行业', '成立年限', '企业规模', '专利数量', '软件著作权', ...questions.map(question => question.label)];
  function portraitRows(task) {
    const answers = answersOf(task);
    const region = (answers.region === '其他地区' ? '' : answers.region) || task.company.region || '';
    const industry = (answers.industry === '其他行业' ? '' : answers.industry) || task.company.industry || '';
    const company = companyRows(task);
    const pick = label => company.find(([key]) => key === label)?.[1] || '';
    return [['企业名称', task.company.name], ['所在地区', region], ['所属行业', industry], ['成立年限', pick('成立年限')], ['企业规模', pick('企业规模')], ['专利数量', pick('专利数量')], ['软件著作权', pick('软件著作权')], ...questions.map(question => [question.label, answers[question.key]])];
  }
  const companyRows = task => {
    const data = mockCompanyData(task);
    if (!data) return [];
    const answers = answersOf(task), founded = companyNotFound(task) ? '' : REAL_COMPANIES[companyKey(task)]?.founded || '';
    // 成立年限按工商成立日期算到今天；人数没有核实到公开来源，只用用户填写的。
    const years = founded ? Math.max(0, Math.floor((Date.parse(today()) - Date.parse(founded)) / 31557600000)) : null;
    const base = [['成立年限', years === null ? answers.founded || '' : `${years} 年`], ['企业规模', answers.scale || '']];
    return [...base, ['专利数量', data.patents===null?(companyNotFound(task)?'':'待核实'):`${data.patents} 个`], ['软件著作权', data.copyrights===null?(companyNotFound(task)?'':'待核实'):`${data.copyrights} 个`]];
  };

  /* 区间条件（PRD V2.2 8.1.4）：整个区间都达到算满足，整个区间都达不到算不满足；
     跨过门槛时记“待确认”，用追问气泡让用户点“达到了 / 没达到 / 不确定”，答案存在画像里。 */
  const REVENUE_RANGES = { '500万以下': [0, 500], '500-2000万': [500, 2000], '2000-5000万': [2000, 5000], '5000万-1亿': [5000, 10000], '1-2亿': [10000, 20000], '2-5亿': [20000, 50000], '5-10亿': [50000, 100000], '10亿以上': [100000, Infinity] };
  const RD_RANGES = { '2%以下': [0, 2], '2%-3%': [2, 3], '3%-4%': [3, 4], '4%-5%': [4, 5], '5%-10%': [5, 10], '10%-15%': [10, 15], '15%以上': [15, Infinity] };
  const RANGES = { revenue: REVENUE_RANGES, rd: RD_RANGES };
  const rangeKey = (key, need) => `${key === 'revenue' ? 'revenue' : key}At_${need}`;
  function revenueCheck(task, need, key = 'revenue') {
    const answers = answersOf(task), pick = answers[key], range = RANGES[key][pick];
    if (!range) return { have: null, display: '待补充' };
    const [low, high] = range, said = answers[rangeKey(key, need)];
    if (low >= need) return { have: need, display: pick };
    if (high < need) return { have: low, display: pick };
    if (said === 'yes') return { have: need, display: `${pick}（已确认达到）` };
    if (said === 'no') return { have: low, display: `${pick}（已确认没达到）` };
    return { have: null, display: `${pick}（待确认）`, straddle: true, pick, unsure: said === 'unsure' };
  }
  function policyMetrics(task, policy) {
    const data = mockCompanyData(task);
    return policyRules(policy).map(rule => rule.interval ? (() => { const r = revenueCheck(task, rule.need, rule.key); return { ...rule, ...r, met: r.have !== null && r.have >= rule.need }; })() : ({ ...rule, have: data ? data[rule.key] : null, met: data && data[rule.key]!==null ? data[rule.key] >= rule.need : false }));
  }

  const metricUnit = unit => unit === '人' ? '名' : unit;
  const metricLine = ({ label, need, unit, have }) => `政策需要 ${need} ${metricUnit(unit)}${label}，您目前有 ${have} ${metricUnit(unit)}`;

  /* 单条政策的结构化对照：企业有什么、还缺什么。只用已知信息，不推断企业满足条件。 */
  function policyGap(task, policy) {
    const have = [], lack = [];
    const { region, industry } = factsOf(task), answers = answersOf(task);
    if (policy.region === '全国') have.push('全国范围的政策，地区不受限');
    else if (region) (region === policy.region ? have : lack).push(region === policy.region ? `企业在${region}，符合政策地区` : `政策面向${policy.region}，企业在${region}`);
    if (industry && industry !== '其他行业') (policy.industries.includes(industry) ? have : lack).push(policy.industries.includes(industry) ? `${industry}在政策涉及的行业内` : `政策涉及的行业里没有${industry}`);
    questions.forEach(question => { if (answers[question.key]) have.push(`${question.label}：${answers[question.key]}`); });
    const files = filesOf(task).length;
    if (files) have.push(`已上传 ${files} 份文件，待核对`);
    policyMetrics(task, policy).forEach(metric => {
      const { label, need, unit, have: count, met } = metric;
      if (count === null) lack.push(`政策需要 ${need} ${metricUnit(unit)}${label}`);
      else if (met) have.push(metricLine(metric));
      else {
        if (count > 0) have.push(`${label} ${count} ${unit}`);
        lack.push(`${metricLine(metric)}，还差 ${need - count} ${metricUnit(unit)}`);
      }
    });
    const items = policy.application?.checklist;
    if (items) {
      items.forEach(item => {
        const id = `${policy.id}-${item.id}`;
        const note = item.note ? `（${item.note}）` : '';
        if (item.kind === 'condition') {
          if (task.requirements?.some(entry => entry.id === id && entry.status === 'ready')) have.push(`已核对：${item.label}`);
          else lack.push(`待确认：${item.label}${note}`);
        } else if (task.sources?.some(source => source.id === id && source.provided)) have.push(`已有：${item.label}`);
        else if (item.required !== false) lack.push(`${item.label}${note}`);
      });
    } else {
      policy.conditions.forEach(condition => lack.push(`待确认：${condition}`));
      policy.materials.forEach(material => lack.push(`需要准备：${material}`));
      if (!policy.conditions.length && !policy.materials.length) lack.push('原文没有列出具体要求，以原文为准');
    }
    return { have, lack };
  }

  const patentServices = [
  {
    "id": 481099123631909,
    "name": "专利挖掘与技术交底书撰写辅导",
    "description": "梳理技术创新点，辅导完成技术交底书撰写。",
    "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260921/147c9c9b-6cea-4471-a022-e7d524a6f593/012_06%E5%B7%A6%E5%AF%B9%E9%BD%90%E5%BA%8F%E5%8F%B7%E5%88%97%E4%B8%BE_%E4%B8%93%E5%88%A9%E6%8C%96%E6%8E%98%E4%B8%8E%E6%8A%80%E6%9C%AF%E4%BA%A4%E5%BA%95%E4%B9%A6%E6%92%B0%E5%86%99%E8%BE%85%E5%AF%BC.png"
  },
  {
    "id": 474618015867237,
    "name": "高价值发明专利申请 （含专利挖掘或检索）",
    "description": "结合技术交底与检索结果，撰写发明专利申请文件。",
    "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260911/257e750e-cdf3-4595-9d3d-6c85725ce463/%E9%AB%98%E4%BB%B7%E5%80%BC%E5%8F%91%E6%98%8E%E4%B8%93%E5%88%A9%E7%94%B3%E8%AF%B7.png"
  },
  {
    "id": 459820346444869,
    "name": "实用新型专利风险代理",
    "description": "前置新颖性检索，持证代理人撰写，驳回可按约定申请退费。",
    "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260723/5eb88cf3-b0be-4f54-bb8f-3f03362f8359/%E4%B8%93%E5%88%A9%E4%BA%8B%E5%8A%A1%E6%89%80%E6%B7%98%E5%AE%9D%E5%BA%97%E9%93%BA%E7%85%A7%E7%89%87%E8%AE%BE%E8%AE%A1_%282%29.png"
  },
  {
    "id": 474660929745317,
    "name": "外观专利设计申请",
    "description": "准备外观设计申请文件，完成提交与审查意见答复。",
    "cover": "https://cdn-esp.wdsheng.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260911/f43e2d4a-8f7d-44c5-addd-7c0b871470f1/%E5%A4%96%E8%A7%82.png"
  },
  {
    "id": 474663519678885,
    "name": "发明专利交底材料整理",
    "description": "代理人与发明人沟通并整理交底材料，同步进行检索。",
    "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260911/1a7d043e-b523-4ce2-86b4-b9fd9ceb2f20/%E4%BA%A4%E5%BA%95%E6%95%B4%E7%90%86.png"
  },
  {
    "id": 483900867303493,
    "name": "专利导航",
    "description": "根据企业实际情况，提供定制化分析方案。",
    "cover": "https://cdn-esp.wdsheng.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260929/5082c813-826f-4f49-9d0d-a448fae960bc/02_%E4%B8%93%E5%88%A9%E5%AF%BC%E8%88%AA.jpg"
  }
];
  const patentServiceDestination = 'https://www.wdsheng.com/employer/find-service/detail/479304003798693';
  /* 换一批：只换卡片本身，抽屉不重绘、不滚动。 */
  const serviceBatchSize = 2;
  const serviceCards = () => { const b = serviceBatches.patent || 0; return patentServices.slice(b*serviceBatchSize,(b+1)*serviceBatchSize).map(service=>marketCard(service, SERVICE_DETAIL(service.id))).join(''); };
  /* AI 建议：学芝麻分的提分逻辑，说清现在多少、做哪一步、能提到多少。数字只来自对照表的分项差额；有专利缺口时优先推专利服务。 */
  /* 服务推荐（PRD 8.1.6）：按差距类型推荐万大圣服务。点“了解服务”新窗口打开官网；点“暂不需要”后本次会话同类不再出现。 */
  const SERVICE_DETAIL = id => `https://www.wdsheng.com/employer/find-service/detail/${id}`;
  // 万大圣公开服务（2026-11-10 从服务大厅检索并核对详情），简介按原文压缩。
  const serviceCatalog = {
    "qualification": [
      {
        "id": 479984587933477,
        "name": "高新技术企业认定申报辅导",
        "description": "对照认定条件逐项体检，输出差距补齐清单，专家网报代办。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260918/e30715a4-4572-4e17-9337-b4f4c0f390ce/008_18%E6%9E%81%E7%AE%80%E7%BA%AF%E6%A0%87%E9%A2%98_%E9%AB%98%E6%96%B0%E6%8A%80%E6%9C%AF%E4%BC%81%E4%B8%9A%E8%AE%A4%E5%AE%9A%E7%94%B3%E6%8A%A5%E8%BE%85%E5%AF%BC.png"
      },
      {
        "id": 479652599469733,
        "name": "高新技术企业认定代办",
        "description": "材料准备、审计协调、提交审核和现场核查指导全流程代办。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260917/bbe6334e-49c7-4cd1-9ff7-f9d81923e65b/041_14%E5%A4%A7%E5%BA%8F%E5%8F%B7%E8%83%8C%E6%99%AF%E5%AD%97_%E9%AB%98%E6%96%B0%E6%8A%80%E6%9C%AF%E4%BC%81%E4%B8%9A%E8%AE%A4%E5%AE%9A%E4%BB%A3%E5%8A%9E.png"
      },
      {
        "id": 481079252424453,
        "name": "高新技术企业认定与复审辅导",
        "description": "盘点研发项目和费用归集，编制申报材料并跟进评审。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260921/1048de3b-17fa-4291-b5d8-46fc6574ca5d/020_10%E6%A0%87%E7%AD%BE%E8%83%B6%E5%9B%8A_%E9%AB%98%E6%96%B0%E6%8A%80%E6%9C%AF%E4%BC%81%E4%B8%9A%E8%AE%A4%E5%AE%9A%E4%B8%8E%E5%A4%8D%E5%AE%A1%E8%BE%85%E5%AF%BC.png"
      },
      {
        "id": 483910031161477,
        "name": "地方国家高新技术企业认定",
        "description": "不通过免服务费再次申报，直到通过。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260929/4a88f359-2188-4b24-abbc-ccf5c1f8b4d3/09_%E5%9C%B0%E6%96%B9%E5%9B%BD%E5%AE%B6%E9%AB%98%E6%96%B0%E6%8A%80%E6%9C%AF%E4%BC%81%E4%B8%9A%E8%AE%A4%E5%AE%9A.jpg"
      }
    ],
    "rdFee": [
      {
        "id": 482476909455493,
        "name": "高新研发费用归集与材料组织",
        "description": "按高新口径重新归集研发费用，组织佐证材料。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260925/43a4fd5b-5ae2-4b1e-8112-40ddff55a494/020_%E4%BB%BB%E6%99%93%E9%94%8B_icon_%E7%99%BD0.png"
      },
      {
        "id": 481522730002501,
        "name": "高新认定研发费用归集专项辅导",
        "description": "梳理研发立项与费用科目，搭建研发费用辅助账。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260922/f34f73bc-a395-41b0-a2d9-f272ae1adb6e/020_%E4%BB%BB%E6%99%93%E9%94%8B.png"
      },
      {
        "id": 487683634370693,
        "name": "高企研发费用归集与辅助账建立",
        "description": "按口径建辅助账，人员工时与立项材料配套。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20261010/81af85f1-5130-4f61-9d2c-0f343b958393/020_%E4%BB%BB%E6%99%93%E9%94%8B_%E9%AB%98%E4%BC%81%E7%A0%94%E5%8F%91%C2%B7%E5%BD%92%E9%9B%86%E5%BB%BA%E8%B4%A6.png"
      },
      {
        "id": 488452433975397,
        "name": "研发费用加计扣除归集与佐证整理",
        "description": "按项目归集研发费用并整理佐证，口径前后一致。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20261012/1b647946-3a93-48cb-a2a7-4dc8d07716c7/018_%E4%BB%BB%E6%99%93%E9%94%8B_%E7%A0%94%E5%8F%91%E5%8A%A0%E8%AE%A1%C2%B7%E5%BD%92%E9%9B%86%E4%BD%90%E8%AF%81.png"
      }
    ],
    "material": [
      {
        "id": 482476746877093,
        "name": "市级政策项目申报包装辅导",
        "description": "对照评审要点包装申报材料，突出企业亮点与佐证。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260925/1b2995a8-ba64-452f-84b0-0c11dc39f3f7/018_%E4%BB%BB%E6%99%93%E9%94%8B_card_%E8%93%9D9.png"
      },
      {
        "id": 481415378294757,
        "name": "政府项目申报商业计划书撰写",
        "description": "按申报要求撰写项目计划书，配套答辩提纲与预算说明。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260922/18c69099-88a0-4a35-ae3c-f0a598e8903d/055_%E9%93%B6%E8%89%AF%E5%8D%8E_%E5%95%86%E4%B8%9A%E8%AE%A1%E5%88%92%E4%B9%A6.png"
      },
      {
        "id": 491047647004997,
        "name": "技术改造项目申报与设备清单组织",
        "description": "按申报口径组织设备与购置凭证材料。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20261019/f9d726c8-cd98-4991-b050-ffb31831e5ee/018_%E4%BB%BB%E6%99%93%E9%94%8B_%E6%8A%80%E6%94%B9%E9%A1%B9%E7%9B%AE%C2%B7%E7%94%B3%E6%8A%A5%E6%9D%90%E6%96%99.png"
      },
      {
        "id": 483213261625509,
        "name": "新建项目可研报告与立项申报",
        "description": "按立项口径编制可研报告，市场、技术和财务测算一起过。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260927/5d525d49-faa2-4b8a-9326-2c87ab884275/053_%E9%93%B6%E8%89%AF%E5%8D%8E_icon_%E7%99%BD6.png"
      }
    ],
    "handling": [
      {
        "id": 479304003798693,
        "name": "地区政策申报-项目补贴",
        "description": "撰写补贴资料、准备答辩，全流程跟进到拿到补贴。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260917/c0aae314-7527-4add-a652-42661ce76f24/watermark_2fcf711d-fc56-40b6-8edd-1c706d15d52b.png"
      },
      {
        "id": 473965891854757,
        "name": "企业项目申报外包服务",
        "description": "提供项目规划、申请及后期服务。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260902/983226af-d2d8-4730-a0d9-722131e6a267/7194ad3f5c31511866981d07a720cdd7.png"
      },
      {
        "id": 483898557151301,
        "name": "知识产权—项目申报",
        "description": "专人对接，资料标准化撰写，提前排查风险。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260929/c3f73f84-b6ae-4bd7-b5dd-3d2b13627b2a/%E5%8F%AA%E6%98%AF%E4%BA%A7%E6%9D%83.jpeg"
      }
    ],
    "risk": [
      {
        "id": 486788512569413,
        "name": "企业信用修复与经营异常移出协办",
        "description": "梳理异常成因，组织修复材料，跟进移出进度。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20261007/de00a507-8ad4-4d84-97e1-7e749e0f3f9f/099_%E7%8E%8B%E7%BE%BD_%E4%BF%A1%E7%94%A8%E4%BF%AE%E5%A4%8D%C2%B7%E5%BC%82%E5%B8%B8%E7%A7%BB%E5%87%BA.png"
      },
      {
        "id": 480709878961925,
        "name": "企业信用修复与经营异常移出代办",
        "description": "补办年报、更正公示信息，提交移出申请并跟进审核。",
        "cover": "https://cdn-esp.wanmol.com/espprod/wlyd-oss-aiplatform-esp-public/114/20260920/c69926c5-dd2f-4b43-91c3-90a830a4457b/094_13%E5%B7%A6%E7%AB%96%E6%9D%A1%E6%A0%87%E9%A2%98_%E4%BC%81%E4%B8%9A%E4%BF%A1%E7%94%A8%E4%BF%AE%E5%A4%8D%E4%B8%8E%E7%BB%8F%E8%90%A5%E5%BC%82%E5%B8%B8%E7%A7%BB%E5%87%BA%E4%BB%A3%E5%8A%9E.png"
      }
    ]
  };
  const serviceKinds = {
    qualification: { title: '离政策要求只差一点，看看资质认定辅导', sub: '万大圣 · 资质认定服务' },
    rdFee: { title: '研发费用归集不规范会影响认定', sub: '万大圣 · 研发费用归集服务' },
    material: { title: '材料问题较多，可以找人帮忙改', sub: '万大圣 · 申报材料服务' },
    handling: { title: '申报有困难？了解专业申报服务', sub: '万大圣 · 项目申报服务' },
    risk: { title: '经营异常会影响申报资格', sub: '万大圣 · 信用修复服务' },
  };
  const SERVICES_OFF = true;
  const dismissedServices = new Set();
  const serviceBatches = {};
  const marketCard = (service, href) => `<a class="interpret-service-card is-marketplace" href="${href}" target="_blank" rel="noopener noreferrer"><img class="interpret-service-thumbnail" src="${esc(service.cover)}" alt="" width="76" height="76" loading="lazy"><div class="interpret-service-copy"><h4>${esc(service.name)}</h4><p>${esc(service.description)}</p><span class="interpret-service-entry">查看服务 ${icon('arrow')}</span></div></a>`;
  const kindCards = kind => { const list = serviceCatalog[kind] || [], b = serviceBatches[kind] || 0; return list.slice(b * serviceBatchSize, (b + 1) * serviceBatchSize).map(item => marketCard(item, SERVICE_DETAIL(item.id))).join(''); };
  /* 所有服务推荐统一成专利服务那种样式：标题、来源、换一批、两张服务卡。“暂不需要”后本次会话同类不再出现。 */
  function serviceSection(kind, { num = '', title = '', sub = '', cards = '', pages = 0 } = {}) {
    if (SERVICES_OFF) return '';  // V2.2：一期不做服务推荐，代码保留给二期
    if (dismissedServices.has(kind)) return '';
    const meta = serviceKinds[kind] || {};
    const total = pages || Math.ceil((serviceCatalog[kind] || []).length / serviceBatchSize);
    const refresh = total > 1 ? `<button type="button" class="text-button interpret-service-refresh" data-action="interpret-services-refresh" data-kind="${kind}">${icon('refresh')} 换一批</button>` : '';
    return `<section class="interpret-services svc-section" data-service-kind="${kind}" aria-label="服务推荐"><div class="interpret-section-heading">${num ? `<span>${num}</span>` : ''}<div><h3>${esc(title || meta.title)}</h3><p>${esc(sub || meta.sub)}</p></div>${refresh}<button type="button" class="text-button svc-dismiss" data-action="service-dismiss" data-kind="${kind}">暂不需要</button></div><div class="interpret-service-grid" aria-live="polite">${cards || kindCards(kind)}</div></section>`;
  }
  const serviceRec = kind => serviceSection(kind);
  const rdLowOptions = ['2%以下', '2%-3%'];
  /* 资质差一点：量化条件只差 1 项，且只差 1～2 个（PRD 8.2.3“差一点”）。研发费用不达标：研发费占比选了 3% 以下，政策是研发或资质方向。 */
  function interpretServices(task, policy, result) {
    if (!task.id || statusOf(policy) !== 'open') return '';
    const gaps = (result?.rows || []).filter(row => row.kind === '量化条件' && row.metric?.have !== null && row.status === 'missing');
    const rd = answersOf(task).rd;
    const out = [];
    // 差的是专利、软著时走知识产权推荐（下方专利服务），这里不重复。
    if (gaps.length === 1 && !['patents', 'copyrights'].includes(gaps[0].key) && gaps[0].metric.need - gaps[0].metric.have <= 2) out.push(serviceRec('qualification'));
    if (rdLowOptions.includes(rd) && ['研发支持', '资质培育'].includes(policy.supportType)) out.push(serviceRec('rdFee'));
    return out.join('');
  }
  function adviceMarkup(policy,result) {
    if(!result||statusOf(policy)!=='open')return '';
    // 先补哪项（PRD V2.2 8.1.6）：排除地区、行业；待补充项排最前（只要告诉我们信息），其次差距最小的一项。
    const unknownStep=result.rows.find(row=>row.kind==='量化条件'&&row.status==='unknown');
    const gaps=result.rows.filter(row=>row.kind==='量化条件'&&row.metric.have!==null&&row.status==='missing'&&!row.metric.interval);
    const step=unknownStep?null:[...gaps].sort((a,b)=>(a.metric.need-a.metric.have)/a.metric.need-(b.metric.need-b.metric.have)/b.metric.need)[0];
    const next=step?scoreOf(result.rows.map(row=>row===step?{...row,status:'ready',metric:{...row.metric,have:row.metric.need}}:row)):result;
    const lift=step&&result.score!==null&&next.grade!==result.grade;
    const now=`按现有信息，这项政策的匹配度为 <b>${result.level}</b>`;
    const text=unknownStep?`${now}。我还不知道您的${esc(unknownStep.label)}，告诉我后帮您重新匹配。`:step?`${now}，补充 ${step.metric.need-step.metric.have} ${metricUnit(step.metric.unit)}${esc(step.metric.label)}后${lift?`，匹配度可从${result.level}提到 <b>${next.level}</b>`:'，更接近政策要求'}。`:result.pending?`${now}。还有 ${result.pending} 项待补充，补充后更准。`:(()=>{const tbc=result.rows.filter(row=>isScored(row)&&row.status==='tbc').length,ind=result.rows.find(row=>row.key==='industry'&&row.status==='missing');return ind||tbc?`${now}。${ind?'企业行业不在政策支持的行业里，申报前核对。':''}${tbc?`还有 ${tbc} 项政策写得不够明确（待确认），以原文为准。`:''}`:`${now}。条件已基本符合，可以准备申报材料。`;})();
    const meter=lift?`<div class="interpret-advice-lift" aria-hidden="true"><div class="interpret-advice-numbers"><span>${result.level}</span>${icon('arrow')}<strong>${next.level}</strong></div><div class="interpret-advice-bar"><i style="width:${result.shown}%"></i><i class="is-gain" style="width:${next.shown-result.shown}%"></i></div></div>`:'';
    return `<aside class="interpret-advice${meter?'':' is-plain'}" aria-label="AI 建议"><div class="interpret-advice-copy"><span class="interpret-advice-tag">${icon('spark')} AI 建议</span><p>${text}</p><small>按现有信息判断，仅供参考，以主管部门审核为准。</small></div>${meter}</aside>`;
  }
  function recommendationMarkup(task,policy,rows) {
    if(!task.id)return '';
    const patents=rows.find(row=>row.key==='patents'&&row.metric?.have!==null&&row.metric?.have<row.metric?.need);
    const title=patents?`还差 ${patents.metric.need-patents.metric.have} 项专利，看看如何补齐`:'专利撰写服务';
    return serviceSection('patent', { num: '03', title, sub: '万大圣 · 专业知识产权服务', cards: serviceCards(), pages: Math.ceil(patentServices.length / serviceBatchSize) });
  }
  const hasNoTemplate = policy => policy?.application?.noTemplate === true;
  function interpretFooter(task,policy) {
    const status=statusOf(policy),chosen=task.steps.match&&task.policyId===policy.id;
    const noTemplate=hasNoTemplate(policy);
    return `<footer class="interpret-footer"><div><span>下一步</span><strong>${status==='closed'?'本期申报已截止':status==='notice'&&!chosen?(ongoing(policy)?'按纳税期常态办理，不是集中申报，到税务机关办理':'暂未开放申报，开放后再来申报'):noTemplate?'这项政策没有申报模板，按办理指引准备':'整理本项政策的申报材料'}</strong></div>${status==='open'||chosen?`<button type="button" class="button button-primary" data-action="interpret-apply" data-task="${esc(task.id)}" data-policy="${esc(policy.id)}">${noTemplate?'查看办理指引':chosen?'去准备材料':'申报这项政策'} ${icon('arrow')}</button>`:`<a class="text-button" href="${esc(policy.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看政策原文 ${icon('arrow')}</a>`}</footer>`;
  }
  /* 对照表的“编辑”在现状格里原地改，同一时间只开一行。 */
  let interpretEditKey = '';
  const fieldOptions = key => [...new Set(publicPolicies().flatMap(policy => key === 'region' ? [policy.region] : policy.industries))].filter(item => item && item !== '全国');
  function comparisonEditor(task,row,attrs) {
    const value=row.metric?row.metric.have:factsOf(task)[row.key];
    const field=row.metric?'type="number" min="0" max="1000000" step="1" placeholder="未知可留空"':`type="text" maxlength="100" list="interpret-field-options" placeholder="填写${esc(row.label)}"`;
    const options=row.metric?'':`<datalist id="interpret-field-options">${fieldOptions(row.key).map(option=>`<option value="${esc(option)}"></option>`).join('')}</datalist>`;
    return `<div class="comparison-edit"><input id="interpret-field" ${attrs} ${field} value="${esc(value??'')}" aria-label="企业${esc(row.label)}">${row.metric?`<span>${esc(row.metric.unit)}</span>`:''}${options}</div>`;
  }
  function comparisonRow(task,policy,row) {
    const labels=row.key==='materials'?{ready:'已上传',missing:'待补充',unknown:'待补充'}:{ready:'符合',missing:'可能不符',unknown:'待补充',tbc:'待确认'},editing=interpretEditKey===row.key;
    const attrs=`data-task="${esc(task.id)}" data-policy="${esc(policy.id)}" data-key="${row.key}"`;
    const current=editing?comparisonEditor(task,row,attrs):`${esc(row.current)}<span class="comparison-state is-${row.status}">${labels[row.status]}${row.key!=='materials'&&STATE_TIPS[labels[row.status]]?helpTip(STATE_TIPS[labels[row.status]]):''}</span>`;
    const actions=editing?'':row.key==='materials'?`<button type="button" class="text-button" data-action="interpret-todo" ${attrs}>${row.status==='ready'?'查看材料':row.action}</button>`:`<button type="button" class="text-button" data-action="interpret-todo" ${attrs} aria-label="编辑${esc(row.label)}">编辑</button>`;
    return `<tr data-dimension="${row.key}" data-state="${row.status}"${editing?' class="is-editing"':''}><th scope="row">${row.label}</th><td>${esc(row.required)}${row.metric?`<small class="interpret-rule-note">${row.metric.unit==='%'?'计算口径':'数量口径'}待原文核实</small>`:''}</td><td>${current}</td><td>${actions}</td></tr>`;
  }
  // 选政策时只对照条件；申报材料等选定政策后在“申报材料”里收集，不在解读里出现。
  const renderComparison = (task,policy) => { document.querySelector('.interpret-table tbody').innerHTML = comparisonRows(task,policy).filter(row=>row.key!=='materials').map(row=>comparisonRow(task,policy,row)).join(''); };
  const focusComparisonEdit = key => document.querySelector(`[data-action="interpret-todo"][data-key="${key}"]`)?.focus({preventScroll:true});
  function cancelInterpretEdit() {
    const field=document.querySelector('#interpret-field'),key=interpretEditKey;
    if(!field||!key)return;
    const task=S().getTask(field.dataset.task),policy=publicPolicies().find(item=>item.id===field.dataset.policy);
    interpretEditKey='';
    if(task&&policy)renderComparison(task,policy);
    focusComparisonEdit(key);
  }
  /* 失焦、回车或点别处都走这里：改了就存，没改只退出编辑，填错恢复原值。 */
  function commitInterpretEdit(focusBack=false) {
    const field=document.querySelector('#interpret-field'),key=interpretEditKey;
    if(!field||!key)return;
    interpretEditKey='';
    const task=S().getTask(field.dataset.task),policy=publicPolicies().find(item=>item.id===field.dataset.policy);
    const row=task&&policy&&comparisonRows(task,policy).find(item=>item.key===key);
    if(!row)return;
    // 输入“上海”也能对上“上海市”，后面的匹配和评分都按标准写法算。
    const typed=field.value.trim(),value=!row.metric&&typed.length>=2&&fieldOptions(key).find(option=>option.startsWith(typed))||typed;
    const invalid=row.metric&&(field.validity?.badInput||value!==''&&(!Number.isInteger(Number(value))||Number(value)<0||Number(value)>1000000));
    const changed=String(row.metric?row.metric.have??'':factsOf(task)[key]||'')!==value;
    if(invalid||!changed){
      renderComparison(task,policy);
      if(invalid)window.PolicyUI.toast('请填写有效的非负整数，这次没有保存。');
      if(focusBack)focusComparisonEdit(key);
      return;
    }
    const answers={...answersOf(task),[row.metric?`metric_${key}`:key]:value};
    const patch={intake:{...(task.intake||{stage:'ready',files:[]}),answers},...(!row.metric?{company:{[key]:value}}:{}),status:'processing',steps:{diagnosis:false,assembly:false,review:false}};
    if(!S().updateTask(task.id,patch)){renderComparison(task,policy);window.PolicyUI.toast('未能保存，请重试。');return;}
    const current=S().getTask(task.id);window.PolicyUI.refresh();updateInterpretDrawer(current,policy);
    if(focusBack)focusComparisonEdit(key);
    window.PolicyUI.toast('结果已更新。');
  }
  /* 这些资格条件平台核对不了，申报前让用户自己确认。 */
  function conditionsNotice(policy) {
    const items = (policy.application?.checklist || []).filter(item => item.kind === 'condition');
    return items.length ? `<div class="interpret-conditions"><h4>申报前请确认</h4><ul>${items.map(item => `<li>${esc(item.label)}${item.note ? `<small>${esc(item.note)}</small>` : ''}</li>`).join('')}</ul></div>` : '';
  }
  function interpretCard(task, policy) {
    const result=policyScore(task,policy),rows=result?.rows||comparisonRows(task,policy),materials=rows.find(row=>row.key==='materials');
    const pending=rows.filter(row=>row.status!=='ready'&&row.key!=='materials').length;
    const facts=[['支持方向',policy.supportType],['适用地区',policy.region],['申报时间',confOf(policy,'applicationEnd')==='low'?'见政策原文':windowText(policy),confTag(confOf(policy,'applicationEnd'))],...(policy.subsidy?[['扶持金额',`${policy.subsidy.prefix||''}${policy.subsidy.value}${policy.subsidy.unit}`,confTag(confOf(policy,'subsidy'))]]:[]),['发布机构',policy.agency]];
    return `<div class="policy-review"><section class="interpret-overview"><div class="interpret-eyebrow">01 / 了解政策</div><h3><a class="interpret-title" href="${esc(policy.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(policy.title)} ${icon('arrow')}</a></h3>${sim('interpretFail') ? `<div class="interpret-summary is-failed" role="status"><p>白话解读暂时没有生成，下面先列出从原文提取的字段，请稍后重试。</p><button type="button" class="text-button" data-action="interpret-retry" data-task="${esc(task.id)}" data-policy="${esc(policy.id)}">重试</button></div>` : `<p class="interpret-summary">${esc(policy.summary)}</p>`}<div class="interpret-summary-grid"><dl class="interpret-facts">${facts.map(([label,value,tag=''])=>`<div><dt>${label}</dt><dd>${esc(value)}${tag}</dd></div>`).join('')}</dl><div class="interpret-score-result"><span>匹配度</span><strong data-total-score="${result?.score??''}">${result?result.level:'—'}</strong><div><b>${pending}</b> 项可能不符或未知</div>${suggestPause(result, policy) ? pauseTag : ''}<small>${{ open: '地区、行业只做准入判断，未知不过滤；其余条件每项权重相同，满足越多越高；材料不计入匹配度', notice: ongoing(policy) ? '按纳税期常态办理，不是集中申报' : '暂未开放申报，可以提前准备', closed: '本期已截止，无法申报' }[statusOf(policy)]}</small></div></div>${conditionsNotice(policy)}</section><section class="interpret-comparison" aria-labelledby="comparison-title"><div class="interpret-section-heading"><span>02</span><div><h3 id="comparison-title">逐项对照，看看还差什么</h3><p>逐项核对企业现状是否符合政策要求。</p></div></div><div class="interpret-table-scroll" tabindex="0" role="region" aria-label="政策条件对照表"><table class="interpret-table"><thead><tr><th scope="col">对照维度</th><th scope="col">政策要求</th><th scope="col">企业现状</th><th scope="col">操作</th></tr></thead><tbody>${rows.filter(row=>row.key!=='materials').map(row=>comparisonRow(task,policy,row)).join('')}</tbody></table></div>${rangeAskInline(task,policy)}<div id="interpret-supplement" aria-live="polite"></div>${policy.applicationTimeNote?`<p class="interpret-time-note">${esc(policy.applicationTimeNote)}</p>`:''}</section>${adviceMarkup(policy,result)}${interpretServices(task,policy,result)}${recommendationMarkup(task,policy,rows)}<p class="interpret-disclaimer">本产品仅提供信息检索、解读与申报指引，不构成申报或权益承诺，最终以政府官方平台审核为准。</p></div>`;
  }

  function updateInterpretDrawer(task,policy) {
    const drawer=document.querySelector('#match-drawer');if(!drawer)return;
    drawer.querySelector('.match-drawer-body').innerHTML=interpretCard(task,policy);
    const footer=interpretFooter(task,policy);
    drawer.querySelector('.interpret-footer').outerHTML=drawer.dataset.from==='recheck'?footer.replace(/<button type="button" class="button button-primary"[\s\S]*?<\/button>/,''):footer;
  }
  function materialsMarkup(task,policy) {
    const items=(policy.application?.checklist||[]).filter(item=>item.kind!=='condition'&&item.required!==false);
    return `<div class="interpret-supplement-card"><h4>本项政策的材料清单</h4><ul>${items.map(item=>`<li>${task.sources.some(source=>source.id===`${policy.id}-${item.id}`&&source.provided)?'已上传':'待准备'} · ${esc(item.label)}</li>`).join('')||'<li>请先核对原文中的材料要求。</li>'}</ul><button type="button" class="button button-primary" data-action="interpret-apply" data-task="${esc(task.id)}" data-policy="${esc(policy.id)}">${task.policyId===policy.id?'去上传材料':'选定这项政策，上传材料'} ${icon('arrow')}</button></div>`;
  }

  function interpretMarkup(task) {
    if (!task || !interpretActive(task)) return '';
    return interpretPicker(task);
  }

  const interpretPicking = task => Boolean(task) && !interpretId(task);

  /* ---------- 只想了解政策：不填企业名称、不建项目 ---------- */
  const guest = { policyId: '', messages: [], applying: false };
  const guestTask = () => ({ id: '', company: { name: '', region: '', industry: '' }, steps: {}, interpretPolicyId: guest.policyId, requirements: [], sources: [] });

  function guestMarkup() {
    const row = message => message.role === 'user' ? userBubble(message.text) : assistantBubble(message.text, '', 'match');
    const form = guest.applying ? assistantBubble('告诉我企业名称，我接着帮你查还差什么。', `<form id="company-start-form" class="intake-card home-start-card" data-work="diagnosis" data-apply-policy="${esc(guest.policyId)}"><div class="intake-name-row"><label for="start-company-name">企业名称</label><input id="start-company-name" name="companyName" type="text" maxlength="300" required autocomplete="organization" placeholder="请输入企业全称"></div><div class="intake-foot is-end"><button type="submit" class="button button-primary">继续 ${icon('arrow')}</button></div></form>`, 'match') : '';
    return `${interpretMarkup(guestTask())}${guest.messages.map(row).join('')}${form}`;
  }

  function guestAsk(text) {
    guest.messages.push({ role: 'user', text, workId: 'match' }, { role: 'assistant', text: window.PolicyChat.answerFor(guestTask(), text, 'match'), workId: 'match' });
  }

  function finishGuest(task, policyId) {
    const policy = publicPolicies().find(item => item.id === policyId);
    if (!policy) return false;
    const saved = S().updateTask(task.id, { ...chooseStep(task, policy), interpretPolicyId: policy.id, messages: guest.messages.map(message => ({ ...message, expertId: 'policy-adviser' })) });
    Object.assign(guest, { policyId: '', messages: [], applying: false });
    return saved;
  }

  function resetGuest() {
    closeDrawer();
    resetPick();
    Object.assign(guest, { policyId: '', messages: [], applying: false });
    Object.assign(homeIntake, { open: false, answers: {} });
  }

  function handleGuest(action, target) {
    if (action === 'match-drawer') { openDrawer(guestTask(), target); return; }
    closeDrawer();
    if (action === 'interpret-apply') guest.applying = true;
    window.PolicyUI.refresh();
    if (guest.applying) { const input = document.querySelector('#start-company-name'); input?.scrollIntoView?.({ block: 'nearest' }); input?.focus({ preventScroll: true }); }
  }

  /* ---------- 右栏企业画像就地编辑 ---------- */
  let portraitEditTask = '';
  const portraitEditing = taskId => portraitEditTask === taskId;

  function swapPortrait(task) {
    const box = document.querySelector('.workspace-summary');
    if (box) box.outerHTML = window.PolicyWorkspace.portraitMarkup(task);
  }

  function portraitField(task, question) {
    const answers = answersOf(task);
    const current = question.key === 'region' ? answers.region || task.company.region : question.key === 'industry' ? answers.industry || task.company.industry : answers[question.key];
    const options = [...question.options, ...(current && !question.options.includes(current) ? [current] : [])];
    return `<select id="portrait-${question.key}" data-portrait-field="${question.key}"><option value="">待补充</option>${options.map(option => `<option value="${esc(option)}"${option === current ? ' selected' : ''}>${esc(option)}</option>`).join('')}</select>`;
  }

  function portraitEditor(task) {
    // 地区、行业来自企业接口，接口不对或没有时用户在这里改。
    const facts = [{ key: 'region', label: '所在地区', options: fieldOptions('region') }, { key: 'industry', label: '所属行业', options: fieldOptions('industry') }];
    const rows = [...facts, ...questions].map(question => `<div><label for="portrait-${question.key}">${esc(question.label)}</label>${portraitField(task, question)}</div>`).join('');
    return `<div class="workspace-portrait is-editing"><div><label for="portrait-name">企业名称</label><input id="portrait-name" type="text" maxlength="300" autocomplete="organization" value="${esc(task.company.name)}"></div>${rows}</div><div class="workspace-portrait-actions"><button type="button" class="text-button" data-action="portrait-cancel" data-task="${esc(task.id)}">取消</button><button type="button" class="button button-primary" data-action="portrait-save" data-task="${esc(task.id)}">保存</button></div>`;
  }

  function savePortrait(task) {
    const box = document.querySelector('.workspace-summary');
    const name = box.querySelector('#portrait-name').value.trim();
    if (!name) { window.PolicyUI.toast('企业名称不能为空。'); return; }
    const answers = {...answersOf(task)};
    box.querySelectorAll('[data-portrait-field]').forEach(field => { answers[field.dataset.portraitField] = field.value; });
    // 补上空项不影响已选政策；改了已有的企业事实，后面的结果要重新确认。
    const changed = name !== task.company.name;
    const title = task.title === `${task.company.name} · 政策申报` ? `${name} · 政策申报` : task.title;
    const intake = { ...(task.intake || { stage: 'ready', files: [] }), answers };
    if (!S().updateTask(task.id, { title, intake, company: changed ? { name, ...apiProfile(name) } : { name }, ...(changed ? { steps: { ...resetSteps, profile: false } } : {}) })) { window.PolicyUI.toast('未能保存，请重试。'); return; }
    S().confirmWork(task.id, 'profile');
    portraitEditTask = '';
    window.PolicyUI.refresh();
    window.PolicyUI.toast(changed && task.steps.match ? '已保存，企业信息有变化，请重新确认政策。' : '已保存。');
  }

  /* 上传资料回显时打码：只改显示，存的原文和下载的 Word 不变。 */
  const maskSpan = '<span class="masked" role="img" aria-label="已打码">••••</span>';
  function maskedHtml(text) {
    return esc(text)
      .replace(/(?<!\d)(\d{6})(?:19|20)\d{9}([\dXx])(?!\d)/g, `$1${maskSpan}$2`)
      .replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, `$1${maskSpan}$2`)
      .replace(/(?<!\d)(\d{4})\d{8,11}(\d{4})(?!\d)/g, `$1${maskSpan}$2`)
      .replace(/(法定代表人|法人代表|联系人|负责人)([:：]\s*)([一-龥])[一-龥]{1,3}/g, `$1$2$3${maskSpan}`);
  }

  /* ---------- 材料解析：原文、缺什么、怎么补、润色。规则检查，只对照政策写明的要点 ---------- */
  const wordRules = [
    { test: /我们公司|我司|我们/, problem: '自称偏口语，申报材料建议统一写“本企业”。' },
    { test: /非常|特别|十分/, problem: '程度词没有依据，建议删掉。' },
    { test: /很多/, problem: '数量说得模糊。' },
    { test: /搞(?=[一-龥])|弄好/, problem: '用词偏口语。' },
    { test: /[,;]|(?:^|[^0-9]):/, problem: '混用了半角标点。' },
  ];
  const wordFixes = [[/我们公司|我司|我们/g, '本企业'], [/(非常|特别|十分)/g, ''], [/很多/g, '多项'], [/搞(?=[一-龥])/g, '开展'], [/弄好/g, '完成'], [/,/g, '，'], [/;/g, '；'], [/(^|[^0-9]):/g, '$1：'], [/[ \t]+/g, ' ']];

  const PENDING_MARKS = /[【\[]待(?:补(?:充)?|核对)(?:[：:]([^】\]]*))?[】\]]/g;
  function reviewMaterial(task, source) {
    const policy = publicPolicies().find(item => item.id === task.policyId);
    const item = policy?.application?.checklist.find(entry => `${policy.id}-${entry.id}` === source.id);
    const unreadable = !source.text.trim() || /^【已上传文件：/.test(source.text);
    if (unreadable) return { unreadable: true, original: '', missing: [], advice: [], polished: '', note: item?.note || '' };
    const text = source.text;
    // 只去掉【待补充：…】标记本身再判断写没写到：标记里列的词不算已写到，同一行标记外的正文照常算。
    const marks = [...text.matchAll(PENDING_MARKS)];
    const written = text.replace(PENDING_MARKS, '');
    const missing = (item?.expects || []).filter(word => !written.includes(word));
    const pending = [...new Set(marks.map(match => (match[1] || '').trim() || '相关内容'))];
    const advice = [];
    missing.forEach(word => advice.push(`补充“${word}”：政策要求写明，原文没有提到。`));
    if (!missing.length && pending.length) advice.push(`还有待补充的内容：${pending.join('、')}。`);
    if (text.length < 60) advice.push('内容偏短，建议写清具体做法和结果。');
    if (!/\d/.test(text)) advice.push('没有数字，建议补充金额、人数或时间，方便审核核实。');
    if (/【虚构|示例内容/.test(text)) advice.push('这是示例内容，提交前要换成真实资料。');
    return { unreadable: false, original: text, missing, pending, advice, items: adviceItems(text, missing, pending), hasRequirements: Boolean(item?.expects?.length), note: item?.note || '' };
  }

  /* AI 建议：逐条给出原文、问题和改法。目前是规则检查，没有接模型。 */
  const polishLine = line => wordFixes.reduce((value, [from, to]) => value.replace(from, to), line).trim();
  // 取标记里写的内容（【待补充：xxx】的 xxx）；没写就用标记外的文字。
  const pendingWhat = line => [...line.matchAll(PENDING_MARKS)].map(match => (match[1] || '').trim()).filter(Boolean).join('、') || line.replace(PENDING_MARKS, '').replace(/^请补充|。$/g, '').trim() || '相关内容';
  function adviceItems(text, missing, pending) {
    const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
    const isMeta = line => /^依据文件：/.test(line) || /^(?:[一二三四五六七八九十]+|\d+)、.{0,20}$/.test(line) || S().hasPendingMark(line);
    const body = lines.filter(line => !isMeta(line));
    const items = lines.filter(line => S().hasPendingMark(line)).map(line => ({ original: line, problem: '这部分还没有内容，不能直接提交。', suggestion: `补写${pendingWhat(line)}后重新上传；也可以多选几份企业文档，重新智能生成。` }));
    // 缺少的政策要点只在预审清单里列，这里不重复。
    [].filter(word => !pending.some(entry => entry.includes(word))).forEach(word => items.push({ original: '材料里没有相关内容', problem: `政策要求写明“${word}”，这份材料还没写到。`, suggestion: `增加一段“${word}”，写清具体内容和数据。` }));
    body.forEach(line => {
      const problems = wordRules.filter(rule => rule.test.test(line)).map(rule => rule.problem);
      const vague = line.match(/大量|显著|明显|领先|一流|较强|较大|丰富/);
      if (problems.length) items.push({ original: line, problem: problems.join(''), suggestion: polishLine(line) });
      if (vague && !/\d/.test(line)) items.push({ original: line, problem: `“${vague[0]}”没有数据支撑，审核不好核实。`, suggestion: `补上可核实的数据：${polishLine(line)}【请填写具体数字】` });
    });
    if (body.length) {
      if (!/\d/.test(body.join(''))) items.push({ original: body[0], problem: '整份材料没有金额、人数或时间，审核不好核实。', suggestion: `在这句后补充具体数字：${polishLine(body[0])}【金额、人数或时间】` });
      if (text.length < 60) items.push({ original: body[0], problem: '内容偏短，看不出具体做法和结果。', suggestion: '写清做了什么、怎么做、取得了什么结果，再重新上传。' });
      if (/【虚构|示例内容/.test(text)) items.push({ original: body[0], problem: '这是示例内容，不能用于提交。', suggestion: '换成企业的真实资料后重新上传。' });
    }
    return items;
  }

  /* 材料行下面的一句话建议，详情在“查看”的抽屉里。 */
  function materialAdvice(task, source) {
    const policy=publicPolicies().find(item=>item.id===task.policyId);
    const checklistItem=policy?.application?.checklist.find(entry=>`${policy.id}-${entry.id}`===source.id);
    if (checklistItem?.media) return `已收到。照片、视频的内容需要人工核对${checklistItem.note ? `；要求：${checklistItem.note}` : ''}。`;
    const review = reviewMaterial(task, source);
    if (review.unreadable) return '这份文件读不到文字，上传 Word 或文本文件后才能解析。';
    if (review.missing.length) return `还没写到${review.missing.slice(0, 3).map(word => `“${word}”`).join('、')}${review.missing.length > 3 ? ' 等内容' : ''}，建议补充。`;
    if (review.advice[0]) return review.advice[0];
    return review.items.length ? `有 ${review.items.length} 处可以调整，点查看。` : '没有发现明显问题。';
  }

  function openMaterialReview(task, opener) {
    closeDrawer();
    const source = task.sources.find(item => item.id === opener.dataset.source);
    if (!source) return;
    const drawer = document.createElement('div');
    drawer.id = 'match-drawer';
    drawer.className = 'match-drawer';
    drawer.dataset.reviewSource = source.id;
    const body = materialReviewBody(task, source);
    drawer.innerHTML = `<button type="button" class="match-drawer-scrim" data-action="match-drawer-close" aria-label="关闭" tabindex="-1"></button><section class="match-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="match-drawer-title"><header><h2 id="match-drawer-title">${esc(source.name)}</h2><button type="button" class="icon-button match-drawer-close" data-action="match-drawer-close" aria-label="关闭" title="关闭">${icon('close')}</button></header><div class="match-drawer-body is-review" tabindex="0">${body}</div></section>`;
    document.body.append(drawer);
    state.drawerReturn = opener;
    drawer.querySelector('.match-drawer-close').focus({ preventScroll: true });
  }

  /* 预审清单（PRD 8.1.7）：逐项给通过 / 待补充 / 不符合和依据；要点缺失过半提示暂缓，但不拦截。 */
  function precheckMarkup(task, source, review) {
    const policy = publicPolicies().find(item => item.id === task.policyId);
    const expects = policy?.application?.checklist.find(entry => `${policy.id}-${entry.id}` === source.id)?.expects || [];
    const rows = [
      ['完整性', review.pending.length ? 'pending' : 'pass', review.pending.length ? `还有待补充的内容：${review.pending.join('、')}` : '文件已上传，没有待补充标记'],
      ...expects.map(word => ['条件符合性', review.missing.includes(word) ? 'fail' : 'pass', review.missing.includes(word) ? `政策要求写明“${word}”，材料里还没有` : `已写到“${word}”`]),
      ['可核实性', /\d/.test(review.original) ? 'pass' : 'pending', /\d/.test(review.original) ? '有具体数字，便于核实' : '全文没有金额、人数或时间，审核不好核实'],
    ];
    const labels = { pass: '通过', pending: '待补充', fail: '不符合' };
    // 严重不符 = 这项政策匹配度为低（PRD V2.2 8.1.4 / 8.1.7）。
    const severe = policy && policyScore(task, policy)?.grade === '低';
    const generated = source.type === 'generated' ? '<p class="precheck-generated">辅助初稿，提交前请人工核对，以政府平台审核为准</p>' : '';
    return `<section class="review-block precheck"><h3>预审清单</h3>${generated}${review.note ? `<p class="review-requirement"><b>政策要求：</b>${esc(review.note)}</p>` : ''}${severe ? '<p class="precheck-severe">建议暂缓申报，先补齐条件。仍可以继续准备。</p>' : ''}<ul class="precheck-list">${rows.map(([item, state, basis]) => `<li><span class="precheck-state is-${state}">${labels[state]}</span><b>${esc(item)}</b><span>${esc(basis)}</span></li>`).join('')}</ul><p class="precheck-note">预审结论不构成官方审核意见</p></section>`;
  }
  function materialReviewBody(task, source) {
    const attrs = `data-task="${esc(task.id)}" data-source="${esc(source.id)}"`;
    const policyForSource=publicPolicies().find(item=>item.id===task.policyId);
    const checklistItem=policyForSource?.application?.checklist.find(entry=>`${policyForSource.id}-${entry.id}`===source.id);
    if (checklistItem?.media && source.provided) {
      const fileName=source.fileName||source.name;
      const mediaAdvice=`已收到。照片、视频的内容需要人工核对${checklistItem.note ? `；要求：${checklistItem.note}` : ''}。`;
      return `<section class="review-file"><div class="review-file-row"><div class="review-file-main"><span class="review-file-label">原文</span><span class="review-file-link">${icon('file')}<span>${esc(fileName)}</span></span></div><div class="review-file-actions"><label class="chat-gap-upload">重新上传<input type="file" data-source-upload ${attrs} accept=".jpg,.jpeg,.png,.mp4,.mov" aria-label="重新上传${esc(source.name)}"></label></div></div></section><section class="review-ai" aria-label="AI 建议"><header class="review-ai-head"><span class="review-ai-mark" aria-hidden="true">${icon('spark')}</span><h3>AI 建议</h3></header><div class="review-ai-scroll" tabindex="0"><p>${esc(mediaAdvice)}</p></div></section>`;
    }
    if (!source.provided) {
      const policy = publicPolicies().find(item => item.id === task.policyId);
      const spec = policy?.application?.checklist.find(entry => `${policy.id}-${entry.id}` === source.id);
      const note = spec?.note || '';
      // 证照、盖章件、照片、视频、光盘这类（库表 uploadOnly / media）只能上传，不给 AI 生成。
      const uploadOnly = Boolean(spec?.uploadOnly || spec?.media);
      const accept = spec?.media ? '.jpg,.jpeg,.png,.mp4,.mov' : '.doc,.docx,.txt,.md,.htm,.html,.pdf,.jpg,.jpeg,.png';
      const ready = `<div class="review-guide-row"><p>「${esc(source.name)}」准备好了？</p><label class="button button-primary review-guide-btn">上传文件<input type="file" data-source-upload ${attrs} accept="${accept}" aria-label="上传${esc(source.name)}"></label></div>`;
      const draft = uploadOnly ? '' : `<div class="review-guide-row"><p>还没准备好？把企业资料批量传上来，我帮您提取、整理成初稿</p><label class="button button-secondary review-guide-btn">批量上传，AI 生成<input type="file" multiple data-source-generate ${attrs} accept="${accept}" aria-label="批量选择企业资料，AI 生成${esc(source.name)}"></label></div>`;
      return `<section class="review-file"><div class="review-file-row"><div class="review-file-main"><span class="review-file-label">原文</span><span class="review-file-none">还没有文件</span></div></div></section><section class="review-block is-lack"><h3>与政策差异</h3>${note ? `<p class="review-requirement"><b>政策要求：</b>${esc(note)}</p>` : ''}<p>上传或生成文件后，我再对照政策要求。</p></section><section class="review-guide" aria-label="准备这份材料">${ready}${draft}</section><section class="review-ai" aria-label="AI 建议"><header class="review-ai-head"><span class="review-ai-mark" aria-hidden="true">${icon('spark')}</span><h3>AI 建议</h3></header><div class="review-ai-scroll" tabindex="0"><p class="review-ai-empty">上传文件后，为您列出材料的问题和修改意见。</p></div></section>`;
    }
    const review = reviewMaterial(task, source);
    const fileName = source.fileName || `${source.name}.doc`;
    const file = `<section class="review-file"><div class="review-file-row"><div class="review-file-main"><span class="review-file-label">原文</span><button type="button" class="review-file-link" data-action="mat-material-download" ${attrs} title="下载 ${esc(fileName)}">${icon('file')}<span>${esc(fileName)}</span></button></div><div class="review-file-actions"><label class="chat-gap-upload">重新上传<input type="file" data-source-upload ${attrs} accept=".doc,.docx,.txt,.md,.htm,.html,.pdf,.jpg,.jpeg,.png" aria-label="重新上传${esc(source.name)}"></label><button type="button" class="text-button review-file-delete" data-action="material-delete" ${attrs}>删除</button></div></div>${review.unreadable ? uploadThumb(task, source) : ''}</section>`;
    const lacks = review.unreadable ? [] : [...review.missing.map(word => `政策要求写明“${word}”，材料里还没有。`), ...(!review.hasRequirements && review.pending.length ? [`材料还有待补充的内容：${review.pending.join('、')}。`] : [])];
    const noneText = review.unreadable ? '读不到文字，暂时无法对照。' : review.hasRequirements ? '已对照政策列出的要点，没有发现差异。提交前再核对政策原文。' : '政策没有列出这份材料的具体要点，请对照政策原文核对。';
    const differences = review.unreadable ? `<section class="review-block is-lack"><h3>与政策差异</h3>${review.note ? `<p class="review-requirement"><b>政策要求：</b>${esc(review.note)}</p>` : ''}<p>${esc(noneText)}</p></section>` : precheckMarkup(task, source, review);
    const items = review.items || [];
    const rows = items.map((item, index) => `<li class="review-ai-item"><span class="review-ai-index">${index + 1}</span><dl><div><dt>原文</dt><dd class="is-original">${maskedHtml(item.original)}</dd></div><div><dt class="is-problem">问题</dt><dd>${esc(item.problem)}</dd></div><div class="is-suggestion"><dt>AI 建议</dt><dd>${maskedHtml(item.suggestion)}</dd></div></dl></li>`).join('');
    const content = review.unreadable ? '<p class="review-ai-empty">这份文件读不到文字。上传 Word（.docx）或文本文件后，才能给出建议。</p>' : items.length ? `<ol class="review-ai-list">${rows}</ol>` : '<p class="review-ai-empty">这份材料没有发现需要修改的地方。</p>';
    const download = items.length ? `<button type="button" class="review-ai-download" data-action="mat-advice-download" ${attrs}>${icon('download')}下载</button>` : '';
    const ai = `<section class="review-ai" aria-label="AI 建议"><header class="review-ai-head"><span class="review-ai-mark" aria-hidden="true">${icon('spark')}</span><h3>AI 建议</h3>${items.length ? `<small>${items.length} 条</small>` : ''}</header><div class="review-ai-scroll" tabindex="0">${content}</div>${download}</section>`;
    const expects = publicPolicies().find(item => item.id === task.policyId)?.application?.checklist.find(entry => `${task.policyId}-${entry.id}` === source.id)?.expects || [];
    const many = !review.unreadable && ((expects.length && review.missing.length * 2 > expects.length) || items.length >= 3);
    return file + differences + ai + (many ? serviceRec('material') : '');
  }

  /* 抽屉里重新上传后，内容跟着换。 */
  function refreshMaterialReview(task, sourceId) {
    const drawer = document.querySelector('#match-drawer');
    const source = task?.sources.find(item => item.id === sourceId);
    if (!drawer || drawer.dataset.reviewSource !== sourceId || !source?.provided) return;
    drawer.querySelector('.match-drawer-body').innerHTML = materialReviewBody(task, source);
  }

  function forgetUpload(taskId, sourceId) {
    const list = mosaics.get(taskId);
    if (list) mosaics.set(taskId, list.filter(item => item.sourceId !== sourceId));
  }

  /* ---------- 上传图片时打码展示：缩到很小再放大，页面上不留清晰原图；只存在当前页面 ---------- */
  const mosaics = new Map();
  const mosaicWidth = 24;

  function rememberUpload(file, taskId = '', work = '', sourceId = '') {
    if (!/^image\//.test(file?.type || '') || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(file), image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = mosaicWidth;
      canvas.height = Math.max(1, Math.round(mosaicWidth * image.naturalHeight / image.naturalWidth));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const list = mosaics.get(taskId) || [];
      mosaics.set(taskId, [...list, { name: file.name, work, sourceId, url: canvas.toDataURL('image/png') }]);
      URL.revokeObjectURL(url);
      window.PolicyUI.refresh();
    };
    image.onerror = () => URL.revokeObjectURL(url);
    image.src = url;
  }

  // 首页还没建项目时上传的图片，建项目后归到这个项目。
  function adoptUploads(taskId) {
    const pending = mosaics.get('');
    if (pending) { mosaics.set(taskId, pending); mosaics.delete(''); }
  }

  function uploadThumb(task, source) {
    const item = (mosaics.get(task.id) || []).filter(entry => entry.sourceId === source.id).at(-1);
    return item ? `<figure class="chat-upload-mosaic"><img src="${esc(item.url)}" alt="${esc(item.name)}，已打码"><figcaption>${esc(item.name)} · 已打码</figcaption></figure>` : '';
  }

  function uploadsMarkup(task, work) {
    const items = (mosaics.get(task?.id || '') || []).filter(item => !item.work || item.work === work);
    return items.map(item => `<div class="chat-message-row is-user"><span class="chat-message-avatar chat-message-user-avatar" aria-hidden="true">企</span><div class="chat-message-body"><figure class="chat-upload-mosaic"><img src="${esc(item.url)}" alt="${esc(item.name)}，已打码"><figcaption>${esc(item.name)} · 已打码</figcaption></figure></div></div>`).join('');
  }

  /* ---------- 首页：填完名称原地展开，确定或跳过后才建项目 ---------- */
  const homeIntake = { open: false, answers: {} };
  const openHomeIntake = () => { homeIntake.open = true; };

  function homeIntakeMarkup() {
    if (!homeIntake.open) return '';
    return `<div class="start-intake" data-home-intake>${questionFields(homeIntake.answers)}<div class="intake-foot"><p class="match-hint" aria-live="polite">${esc(hintText(homeIntake.answers))}</p><div class="intake-foot-actions"><button type="button" class="button button-primary" data-action="home-intake-finish">确定 ${icon('arrow')}</button></div></div></div>`;
  }

  /* 首页和 3 个入口的表单一致（PRD 8.1.3）：企业名称 + 5 项选择，选完一项展开下一项。
     所在地区、所属行业不在表单里问，先从企业接口取；接口没有时，匹配后正在申报少于 3 条才追问。 */
  const quickRevealed = answers => revealedCount(answers);
  const quickHint = answers => hintText(answers);
  function regionField(answers) {
    const options = [...fieldOptions('region'), '其他地区'];
    return `<fieldset class="intake-question"><legend>所在地区</legend><div class="match-options">${options.map(option => `<label class="match-option"><input type="radio" name="region" value="${esc(option)}"${answers.region === option ? ' checked' : ''}><span>${esc(option)}</span></label>`).join('')}</div></fieldset>`;
  }
  function quickIntakeMarkup(name = '', withRegion = false) {
    const answers = homeIntake.answers;
    return `<div class="intake-name-row"><label for="start-company-name">企业名称</label><input id="start-company-name" name="companyName" type="text" maxlength="300" required autocomplete="organization" placeholder="输入企业名称" value="${esc(name)}"></div><div class="start-intake" data-home-intake>${questionFields(answers, quickRevealed(answers))}<div class="intake-foot"><p class="match-hint" aria-live="polite">${esc(quickHint(answers))}</p><div class="intake-foot-actions"><button type="button" class="button button-primary" data-action="home-intake-finish">确定 ${icon('arrow')}</button></div></div></div>`;
  }

  function finishHomeIntake(skip = false) {
    const input = document.querySelector('#start-company-name');
    const name = input?.value.trim();
    if (!name) { window.PolicyUI.toast('请填写企业名称。'); input?.focus(); return; }
    const work = document.querySelector('#company-start-form')?.dataset.work || 'match';
    const task = S().createTask({ title: `${name} · 政策申报`, request: `为${name}查找适用政策并准备申报材料。`, company: { name, ...apiProfile(name) }, ...(work === 'assembly' ? { policyId: 'no-policy' } : {}), intake: { stage: 'fields', answers: { ...homeIntake.answers }, files: [] } });
    if (!task) { window.PolicyUI.toast('未能创建，请重试。'); return; }
    Object.assign(homeIntake, { open: false, answers: {} });
    window.PolicyUI.clearCompanyDraft();
    // V2.2：只有一个“确定”，字段都不是必填；点了先核对画像再匹配。
    if (work === 'match') { askConfirm(task); return; }
    setIntake(task, { stage: 'ready' });
    S().confirmWork(task.id, 'profile');
    window.PolicyUI.navigate('task', { task: task.id, work });
  }

  function revealNext(form, answers) {
    const quickForm = form.closest('.start-quick-form');
    const revealed = revealedCount(answers);
    const next = [...form.querySelectorAll('.intake-question[data-question]')].find((node, index) => index < revealed && node.hidden);
    if (next) {
      next.hidden = false;
      next.classList.add('is-new');
    }
    const hint = form.querySelector('.match-hint');
    if (hint) hint.textContent = hintText(answers);
  }

  /* ---------- 解析动画 ---------- */
  function stageRows(group, answers) {
    return group.keys.map(key => `<div class="match-row"><span>${esc(labelOf(key))}</span><strong>${esc(answers[key] || '未填写')}</strong></div>`).join('');
  }

  function runningMarkup(task) {
    const answers = answersOf(task), files = filesOf(task).length;
    const stages = [...groups.map(group => ({ title: group.title, rows: stageRows(group, answers) })), { title: '比对政策库', rows: `<div class="match-row"><span>比对范围</span><strong>已收录公开政策 ${publicPolicies().length} 项</strong></div><div class="match-row"><span>企业资料</span><strong>${files ? `${files} 份` : '未提供'}</strong></div>` }];
    const card = `<div class="intake-card match-running"><div class="match-running-body"><div class="match-orb" aria-hidden="true"><span class="match-orb-ring"></span><span class="match-orb-ring"></span><span class="match-orb-core" data-orb-label>${state.stage ? '正在匹配中' : '开始匹配'}</span></div><ol class="match-stages" aria-live="polite">${stages.map((stage, index) => `<li class="match-stage" data-stage="${index}"${index > state.stage ? ' hidden' : ''}${index === state.stage ? ' data-state="active"' : ' data-state="done"'}><div class="match-stage-head"><h4>${esc(stage.title)}</h4><span class="match-stage-status" aria-hidden="true"></span></div><div class="match-stage-rows"><div>${stage.rows}</div></div></li>`).join('')}</ol></div></div>`;
    return assistantBubble(`我来帮「${task.company.name}」比对政策。`, card, 'match');
  }


  /* 抽屉里的政策卡：把原文里能确定的信息结构化，没有的不补。 */
  function policyCard(task, { policy, status, reasons }, first) {
    const checks = [...policy.conditions, ...(policy.applicationTimeNote ? [policy.applicationTimeNote] : [])];
    const tag = first ? '首选推荐' : { open: '正在申报', notice: '政策方向', closed: '已截止' }[status];
    const chosen = task.steps.match && task.policyId === policy.id;
    const keywords = [policy.supportType, policy.category, ...policy.industries.slice(0, 3)].filter(Boolean);
    const facts = [['支持方向', policy.supportType], ['适用地区', policy.region], ['申报时间', windowText(policy)], ['发布日期', policy.publishedAt]];
    const left = status === 'open' && policy.applicationStart <= today() || status === 'open' && !policy.applicationStart ? daysLeft(policy) : null;
    const scored = policyScore(task, policy);
    const side = scored ? `<span>匹配度</span><strong>${scored.level}</strong>` : left !== null ? `<span>距离截止</span><strong>${left}<small> 天</small></strong>` : `<span>申报状态</span><strong class="is-text">${{ open: '未开始', notice: '暂无窗口', closed: '已截止' }[status]}</strong>`;
    const list = (title, items) => items.length ? `<div><h4>${title}</h4><ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>` : '';
    return `<article class="match-policy is-full is-${status}${first ? ' is-first' : ''}"><div class="match-policy-main"><p class="match-policy-tag">${tag}</p><h3>${esc(policy.title)}</h3><p class="match-policy-keywords">${keywords.map(esc).join(' / ')}</p><p class="match-policy-summary">${esc(policy.summary)}</p><dl class="match-policy-facts">${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></div><div class="match-policy-side">${side}${status === 'open' ? `<button type="button" class="button ${first ? 'button-primary' : 'button-secondary'}" data-action="match-apply" data-task="${esc(task.id)}" data-policy="${esc(policy.id)}">${chosen ? '已选这项政策' : '申报这项政策'} ${icon('arrow')}</button>` : ''}<a class="match-policy-source" href="${esc(policy.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看政策原文</a></div><div class="match-policy-columns">${list('命中原因', (() => { const all = hitReasons(task, { policy, status, reasons }); return all.length ? all : ['补充企业情况后会给出命中原因']; })())}${list('申报条件', checks)}${list('所需材料', policy.materials)}</div><p class="match-policy-agency"><span>发布部门</span>${esc(policy.agency)}</p></article>`;
  }

  function compactCard(task, item, first, relax) {
    const { policy, status } = item;
    const tag = first ? '首选推荐' : { open: '正在申报', notice: '政策方向', closed: '已截止' }[status];
    const chosen = task.steps.match && task.policyId === policy.id;
    const reason = hitReasons(task, item, relax).slice(0, 2).join('；') || '还没有可判断的信息，补充企业情况后会给出命中原因';
    const scored = policyScore(task, policy) ? ' has-score' : '';
    return `<article class="match-policy is-compact is-clickable is-${status}${first ? ' is-first' : ''}${chosen ? ' is-chosen' : ''}${scored}" data-type="${esc(policy.supportType || '')}"${typePick && policy.supportType !== typePick ? ' hidden' : ''}>${chosen ? `<span class="match-policy-check" role="img" aria-label="已选这项政策">${icon('check')}</span>` : ''}${scoreBadge(task, policy)}<p class="match-policy-tag">${tag}</p><h3><button type="button" class="match-policy-open" data-action="match-drawer" data-task="${esc(task.id)}" data-policy="${esc(policy.id)}">${esc(policy.title)}</button></h3><p class="match-policy-meta">${esc(policy.region)} · ${esc(windowText(policy))}</p><p class="match-policy-reason">${esc(reason)}</p>${viewButton(task, policy)}</article>`;
  }

  /* 政策类型筛选：按政策的支持方向分，和“仅看进行中”可以叠加。 */
  let typePick = '';
  const typeFilter = matches => {
    const types = [...new Set(matches.map(item => item.policy.supportType).filter(Boolean))];
    if (types.length < 2) return '';
    return `<div class="match-type-filter" role="group" aria-label="按政策类型筛选">${['', ...types].map(type => `<button type="button" class="nohit-chip" data-type-pick="${esc(type)}" aria-pressed="${typePick === type}">${type ? esc(type) : '全部类型'}</button>`).join('')}</div>`;
  };
  const applyTypeFilter = root => root?.querySelectorAll('.match-policy[data-type]').forEach(card => { card.hidden = Boolean(typePick) && card.dataset.type !== typePick; });
  document.addEventListener('click', event => {
    const chip = event.target instanceof Element && event.target.closest('[data-type-pick]');
    if (!chip) return;
    typePick = chip.dataset.typePick;
    const root = chip.closest('.match-result');
    root.querySelectorAll('[data-type-pick]').forEach(item => item.setAttribute('aria-pressed', String(item === chip)));
    applyTypeFilter(root);
  });

  /* 政策列表的“仅看进行中”：默认不勾选。 */
  let onlyOpen = false;
  const onlyOpenToggle = () => `<label class="match-only-open"><input type="checkbox" data-only-open${onlyOpen ? ' checked' : ''}><span>仅看进行中</span></label>`;
  document.addEventListener('change', event => {
    if (!(event.target instanceof Element) || !event.target.matches('[data-only-open]')) return;
    onlyOpen = event.target.checked;
    event.target.closest('.match-result')?.classList.toggle('only-open', onlyOpen);
  });

  /* 被过滤的政策（已截止，以及地区、行业不符）不展示，只留正在申报和政策方向。 */
  const visible = list => list.filter(item => item.status !== 'closed');

  /* 命中原因：按 PRD 8.2.3 的模板，从上到下挑，最多 2 条。只用已知信息，不说“一定能申请”。 */
  function hitReasons(task, { policy, status, reasons }, relax) {
    const out = [];
    if (relax) out.push(relax);
    const { region, industry } = factsOf(task);
    const metrics = policyMetrics(task, policy);
    metrics.filter(m => m.have !== null && m.met).forEach(m => out.push(m.interval ? `${m.label}${m.display.includes('已确认') ? '已确认' : '（' + m.display + '）'}达到政策要求的 ${m.need} ${metricUnit(m.unit)}` : `您有 ${m.have} ${metricUnit(m.unit)}${m.label}，达到政策要求的 ${m.need} ${metricUnit(m.unit)}`));
    const items = (policy.application?.checklist || []).filter(item => item.kind !== 'condition' && item.required !== false);
    const missing = items.filter(item => !task.sources?.some(source => source.id === `${policy.id}-${item.id}` && source.provided));
    if (items.length && !missing.length) out.push('申报材料已备齐，可以确认版本');
    else if (items.length && missing.length <= 2 && missing.length < items.length) out.push(`只差 ${missing.length} 份材料就能准备齐：${missing.map(item => item.label).join('、')}`);
    metrics.filter(m => m.have !== null && !m.met && m.need - m.have <= Math.max(1, Math.ceil(m.need / 3))).forEach(m => out.push(`您的${m.label}还差 ${m.need - m.have} ${metricUnit(m.unit)}就达到要求`));
    if (status === 'notice') out.splice(relax ? 1 : 0, 0, ongoing(policy) ? '按纳税期常态办理，不是集中申报' : '暂未开放申报，开放后再来申报');
    if (!relax) {
      if (region && policy.region === region) out.push(`政策面向${region}，与企业所在地一致`);
      else if (policy.region === '全国') out.push('全国范围的政策，不限地区');
      if (industry && policy.industries.includes(industry)) out.push(`您所在的${industry}属于政策支持行业`);
    }
    reasons.forEach(reason => { if (!/和你选的地区一致|全国范围的政策|在这项政策涉及的行业内/.test(reason)) out.push(reason); });
    return [...new Set(out)];
  }

  /* 放宽条件：地区只往上扩一级（市→省，本期没有区县）。企业所在市本来就会带上本省和全国的政策，
     放宽后多出来的是同省其他城市的政策。直辖市没有上一级，不出现“扩大地区范围”。 */
  const regionParent = { 杭州市: '浙江省', 宁波市: '浙江省', 深圳市: '广东省', 广州市: '广东省', 南京市: '江苏省', 苏州市: '江苏省', 成都市: '四川省', 西安市: '陕西省' };
  const industryGroups = [
    { name: '国标门类 C 制造业', members: ['先进制造', '新能源', '生命健康'] },
    { name: '信息技术和科技服务', members: ['软件信息', '现代服务'] },
  ];
  const groupOf = industry => industryGroups.find(group => group.members.includes(industry));
  const neighborsOf = industry => (groupOf(industry)?.members || []).filter(item => item !== industry);
  const relaxText = applied => [applied.region && `地区扩大到${applied.region}`, applied.industry && `行业放宽到相邻的${applied.industry}`].filter(Boolean).join('、');

  /* ---------- 无命中：地区、行业对不上时不硬推政策，让用户按规则放宽条件或找人工客服 ---------- */
  const noHitViews = new Map();
  const noHitView = taskId => noHitViews.get(taskId) || { industry: '', region: '', applied: null, service: false };
  const setNoHitView = (taskId, patch) => noHitViews.set(taskId, { ...noHitView(taskId), ...patch });
  const openFits = facts => matchPolicies(facts).filter(item => item.status === 'open');
  const noHit = facts => (facts.region === '其他地区' && facts.industry === '其他行业') || !openFits(facts).length;

  function noHitRow(task, key, title, options, selected, hint = '', frozen = false) {
    if (!options.length) return '';
    const chips = options.map(option => { const { value, label } = typeof option === 'string' ? { value: option, label: option } : option; return `<button type="button" class="nohit-chip" data-action="nohit-pick" data-task="${esc(task.id)}" data-key="${key}" data-value="${esc(value)}" aria-pressed="${selected === value}"${frozen ? ' disabled' : ''}>${esc(label)}</button>`; }).join('');
    return `<fieldset class="intake-question nohit-row"><legend>${title}</legend><div class="match-options">${chips}</div>${hint ? `<p class="nohit-hint">${esc(hint)}</p>` : ''}</fieldset>`;
  }

  function noHitTitle(task) {
    if (companyApiFailed(task)) return '企业信息暂时查询失败，暂未找到完全匹配的政策。';
    if (companyNotFound(task)) return `没有查到「${task.company.name}」的工商信息，暂未找到完全匹配的政策。`;
    return '暂未找到完全匹配的政策。';
  }

  /* 无命中分两轮：第一轮问要不要放宽（点“确定”后这张卡锁住），第二轮单独一个气泡推放宽后查到的政策。 */
  function noHitCard(task, role) {
    const facts = factsOf(task), view = noHitView(task.id), id = esc(task.id);
    const frozen = Boolean(view.applied);
    const parent = regionParent[facts.region];
    const rows = noHitRow(task, 'region', '扩大地区范围', parent ? [{ value: parent, label: `${facts.region} → ${parent}` }] : [], frozen ? view.applied.region : view.region, '', frozen);  // 行业不做筛选，不需要放宽
    const canConfirm = view.industry || view.region;
    const failed = companyApiFailed(task), hasCompany = failed || companyNotFound(task);
    const focusAttrs = frozen ? '' : ' id="match-result-heading" tabindex="-1"';
    const company = hasCompany ? `<div class="nohit-company" data-inline-slot="nohit"><p${focusAttrs}>${failed ? '按您填写的信息匹配，可以稍后重试查询企业信息。' : '请核对企业全称是否和营业执照一致；也可以补充所在地区、行业后重新匹配。'}</p><button type="button" class="text-button" data-action="${failed ? 'company-retry' : 'company-edit-inline'}" data-task="${id}">${failed ? '重试' : '修改企业名称或补充信息'}</button></div>` : '';
    const inlineCompany = companyInlineEditTasks.has(task.id);
    const relax = rows ? `<div class="nohit-relax"><p${hasCompany ? '' : focusAttrs} class="match-result-heading">可以放宽条件再看看</p><div class="nohit-rows">${rows}</div>${frozen ? '' : `<div class="nohit-confirm"><button type="button" class="button button-primary" data-action="nohit-confirm" data-task="${id}"${canConfirm ? '' : ' disabled'}>确定</button></div>`}</div>` : '';
    // 人工客服跟着最后一个气泡走：已放宽时放到第二轮。
    const service = frozen ? '' : `<div class="nohit-service">${noHitService(task, !hasCompany && !rows ? focusAttrs : '')}</div>`;
    return `<div class="intake-card match-result match-nohit">${inlineCompany ? companyInlineEdit(task, 'nohit') : company}${relax}${service}</div>`;
  }
  function noHitService(task, focusAttrs = '') {
    return noHitView(task.id).service
      ? `<p${focusAttrs} class="nohit-service-done" role="status"${focusAttrs ? '' : ' tabindex="-1"'}>已通知人工客服，稍后会联系您。</p>`
      : `<p${focusAttrs}>需要人帮您看看？</p><button type="button" class="button button-secondary" data-action="nohit-service" data-task="${esc(task.id)}">联系人工客服</button>`;
  }
  // 第二轮：用户确认放宽后的回答。只列放宽后新增的政策（同省其他城市的），已截止的也列出来，卡片上标“已截止”。
  function noHitRelaxed(task, role) {
    const { applied } = noHitView(task.id);
    if (!applied) return '';
    const facts = factsOf(task);
    const before = new Set(matchPolicies(facts).map(item => item.policy.id));
    const pool = matchPolicies({ ...facts, ...(applied.region ? { region: applied.region } : {}), ...(applied.industry ? { industry: applied.industry } : {}) }).filter(item => !before.has(item.policy.id));
    const items = role === 'assembly' ? pool.filter(item => item.status === 'open') : pool;
    const open = items.filter(item => item.status === 'open').length;
    const cond = relaxText(applied);
    const text = !items.length ? `按「${cond}」还是没有合适的政策，可以问问人工客服。` : `以下政策根据「${cond}」查到${open ? `，${open} 项正在申报` : '，暂无正在申报的，可以先了解'}。`;
    const focusAttrs = ' id="match-result-heading" tabindex="-1"';
    const list = items.length ? `<div class="match-result-bar"><p class="nohit-note"${focusAttrs}>这些政策的${applied.region ? '地区' : ''}${applied.region && applied.industry ? '和' : ''}${applied.industry ? '行业' : ''}和企业情况不完全一致，申报前请核对要求。</p>${role === 'match' ? onlyOpenToggle() : ''}</div><div class="match-policy-grid">${items.map(item => compactCard(task, item, false, `按${cond}查到，申报前请核对${[applied.region && '地区', applied.industry && '行业'].filter(Boolean).join('和')}要求`)).join('')}</div>` : '';
    return userBubble(cond) + assistantBubble(text, `<div class="intake-card match-result match-nohit${onlyOpen ? ' only-open' : ''}">${list}<div class="nohit-service">${noHitService(task, items.length ? '' : focusAttrs)}</div></div>`, role);
  }

  /* 区间跨过门槛的追问：同一门槛只问一次，答过（含“不确定”）就不再弹。 */
  function rangeQuestion(task, policies) {
    const asks = policies.flatMap(policy => policyMetrics(task, policy).filter(item => item.interval && item.straddle && !item.unsure).map(item => ({ policy, item })));
    if (!asks.length) return null;
    const { item } = asks[0];
    const titles = [...new Set(asks.filter(entry => entry.item.key === item.key && entry.item.need === item.need).map(entry => entry.policy.title))];
    return { item, titles };
  }
  const rangeNeedText = item => item.key === 'rd' ? `研发费占营业收入比重达到 ${item.need}%` : `营业收入达到 ${item.need} 万`;
  function rangeButtons(task, item, policyId = '') {
    const need = item.need;
    return ['yes', 'no', 'unsure'].map(answer => `<button type="button" class="${answer === 'yes' ? 'button button-primary' : 'button button-secondary'}" data-action="range-answer" data-task="${esc(task.id)}" data-key="${esc(item.key)}" data-need="${need}" data-answer="${answer}"${policyId ? ` data-policy="${esc(policyId)}"` : ''}>${{ yes: '达到了', no: '没达到', unsure: '不确定' }[answer]}</button>`).join('');
  }
  function rangeAskBubble(task, policies) {
    const q = rangeQuestion(task, policies);
    if (!q) return '';
    const { item, titles } = q;
    return assistantBubble(`有 ${titles.length} 项政策要求${rangeNeedText(item)}，您选的是「${item.pick}」，达到了吗？`, `<div class="intake-card range-ask"><p class="range-ask-note">涉及：${titles.map(esc).join('、')}。确认后重新计算匹配度。</p><div class="intake-foot is-end range-ask-actions">${rangeButtons(task, item)}</div></div>`, 'match');
  }
  function rangeAskInline(task, policy) {
    const item = policyMetrics(task, policy).find(entry => entry.interval && entry.straddle && !entry.unsure);
    return item ? `<div class="range-ask is-inline"><p>这项政策要求${rangeNeedText(item)}，您选的是「${esc(item.pick)}」，达到了吗？</p><div class="range-ask-actions">${rangeButtons(task, item, policy.id)}</div></div>` : '';
  }
  function resultMarkup(task) {
    // 查不到企业时，无命中卡片上面同样先提示核对企业名称（PRD 6.3 第 1、2 条）。
    if (noHit(factsOf(task))) return assistantBubble(noHitTitle(task), noHitCard(task, 'match'), 'match') + noHitRelaxed(task, 'match');
    const matches = visible(matchPolicies(factsOf(task)));
    const openCount = matches.filter(item => item.status === 'open').length;
    // 排序（PRD 8.1.4）：状态 → 档位（高、中、暂无法判断、低）→ 内部分值。
    const statusOrder = { open: 0, notice: 1, closed: 2 };
    const gradeRank = item => GRADE_ORDER[policyScore(task, item.policy)?.grade] ?? 9;
    matches.sort((x, y) => statusOrder[x.status] - statusOrder[y.status] || gradeRank(x) - gradeRank(y) || (policyScore(task, y.policy)?.score ?? -1) - (policyScore(task, x.policy)?.score ?? -1));
    const pickIndex = matches.findIndex(item => item.status === 'open' && (policyScore(task, item.policy)?.score ?? -1) >= FIRST_PICK_MIN);
    const cards = matches.map((item, index) => compactCard(task, item, index === pickIndex)).join('');
    const partial = answeredCount(answersOf(task)) < questions.length ? `<p class="match-partial">以下结果基于不完整信息，建议补充后重新匹配。<button type="button" class="text-button" data-action="company-edit-inline" data-task="${esc(task.id)}">补充企业信息</button></p>` : '';
    const facts = factsOf(task);
    const regionHint = !facts.region || facts.region === '其他地区' ? `<p class="match-partial">补充所在地区，能看到地方政策。<button type="button" class="text-button" data-action="company-edit-inline" data-task="${esc(task.id)}">补充企业信息</button></p>` : '';
    const inlineCompany = companyInlineEditTasks.has(task.id);
    const noticeMarkup = inlineCompany ? companyInlineEdit(task, 'result') : (notFoundNotice(task) + regionHint) || partial;
    const card = `<div class="intake-card match-result${onlyOpen ? ' only-open' : ''}">${noticeMarkup}<div class="match-result-bar"><p id="match-result-heading" class="match-result-heading" tabindex="-1">有 ${openCount} 项政策正在申报</p>${onlyOpenToggle()}</div>${typeFilter(matches)}<div class="match-policy-grid">${cards}</div>${diagnosisCard(task)}</div>`;
    // 少于 3 条时的追问并进结果卡片底部，一次只回一张卡片。
    return assistantBubble(`「${task.company.name}」比对完了。`, card + followupBubble(task, openCount, matches.map(item => item.policy), true), 'match');
  }

  /* 少于 3 条正在申报时追问一轮（PRD V2.2 8.1.3）：只问还空着的关键字段（地区、行业、企业规模、成立年限、企业类型），
     每个任务只问一次；补充后重新匹配，跳过就按已有信息展示，空着的字段在画像里显示“待补充”。 */
  const FOLLOWUP_MIN = 3;
  const keyFieldOptions = {
    scale: { label: '企业规模', options: ['20人以下', '20-99人', '100-299人', '300-999人', '1000人以上'] },
    founded: { label: '成立年限', options: ['1年以内', '1-3年', '3-5年', '5-10年', '10年以上'] },
  };
  function missingKeyFields(task) {
    const answers = answersOf(task), facts = factsOf(task), notFound = companyNotFound(task);
    return [
      !facts.region && 'region',
      !facts.industry && 'industry',
      !companyRows(task).find(([label]) => label === '企业规模')?.[1] && 'scale',
      !companyRows(task).find(([label]) => label === '成立年限')?.[1] && 'founded',
      !answers.type && 'type',
    ].filter(Boolean);
  }
  function keyFieldMarkup(key, answers) {
    if (key === 'region') return regionField(answers);
    if (key === 'industry') return industryField(answers);
    const field = keyFieldOptions[key] || { label: labelOf(key), options: questions.find(question => question.key === key).options };
    return `<fieldset class="intake-question"><legend>${esc(field.label)}</legend><div class="match-options">${field.options.map(option => `<label class="match-option"><input type="radio" name="${key}" value="${esc(option)}"${answers[key] === option ? ' checked' : ''}><span>${esc(option)}</span></label>`).join('')}</div></fieldset>`;
  }
  // 跨门槛的区间条件（营收、研发费占比）：同一门槛只问一次，和关键字段放在同一轮追问里（PRD 8.1.3 / 8.1.4）。
  function rangeAsks(task, policies) {
    const seen = new Set();
    return policies.flatMap(policy => policyMetrics(task, policy).filter(item => item.interval && item.straddle && !item.unsure)).filter(item => { const k = `${item.key}|${item.need}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  const rangeFieldMarkup = item => `<fieldset class="intake-question"><legend>${esc(item.key === 'rd' ? `研发费占比达到 ${item.need}%？` : `营业收入达到 ${item.need} 万？`)}</legend><div class="match-options">${[['yes', '达到了'], ['no', '没达到'], ['unsure', '不确定']].map(([value, label]) => `<label class="match-option"><input type="radio" name="range|${esc(item.key)}|${item.need}" value="${value}"><span>${label}</span></label>`).join('')}</div><small class="range-ask-note">您选的是「${esc(item.pick)}」，跨过了政策要求</small></fieldset>`;
  function followupBubble(task, openCount, policies = [], inline = false) {
    if (openCount >= FOLLOWUP_MIN || task.intake?.followupDone) return '';
    const missing = missingKeyFields(task), ranges = rangeAsks(task, policies);
    if (!missing.length && !ranges.length) return '';
    const labels = [...missing.map(key => ({ region: '所在地区', industry: '所属行业', type: '企业类型' }[key] || keyFieldOptions[key].label)), ...ranges.map(item => item.key === 'rd' ? '研发费占比' : '营业收入')];
    const id = esc(task.id);
    const ask = `正在申报的政策只有 ${openCount} 项。补充${[...new Set(labels)].join('、')}，可能找到更多适合的政策。`;
    const body = `<div class="intake-card intake-followup" data-task="${id}">${missing.map(key => keyFieldMarkup(key, answersOf(task))).join('')}${ranges.map(rangeFieldMarkup).join('')}<div class="intake-foot is-end"><button type="button" class="button button-secondary" data-action="followup-skip" data-task="${id}">跳过</button><button type="button" class="button button-primary" data-action="followup-submit" data-task="${id}">补充后重新匹配</button></div></div>`;
    return inline ? `<div class="followup-inline"><p class="followup-ask">${esc(ask)}</p>${body}</div>` : assistantBubble(ask, body, 'match');
  }

  /* 从申报辅助进来还没选政策：列出正在申报的政策，选好后才知道要备哪些材料。 */
  function assemblyPicker(task) {
    if (noHit(factsOf(task))) return assistantBubble(noHitTitle(task), noHitCard(task, 'assembly'), 'assembly') + noHitRelaxed(task, 'assembly');
    const cards = openFits(factsOf(task)).map((item, index) => compactCard(task, item, index === 0)).join('');
    return assistantBubble(`请选择「${task.company.name}」要申报的政策，选好后我按它列出要准备的材料。`, `<div class="intake-card match-result"><div class="match-policy-grid">${cards}</div></div>`, 'assembly');
  }

  /* 全部政策放在右侧抽屉，对话里只留前三项。 */
  function closeDrawer() {
    const drawer = document.querySelector('#match-drawer');
    if (!drawer) return;
    drawer.remove();
    if (state.drawerReturn?.isConnected) state.drawerReturn.focus({ preventScroll: true });
    state.drawerReturn = null;
  }

  function openDrawer(task, opener) {
    closeDrawer();
    const policy = publicPolicies().find(item => item.id === opener.dataset.policy);
    if (!policy) return;
    Object.keys(serviceBatches).forEach(key => { serviceBatches[key] = 0; });
    interpretEditKey = '';
    // 记下正在看的政策，之后在对话里追问就按它回答。
    if (task.id) S().updateTask(task.id, { interpretPolicyId: policy.id });
    else guest.policyId = policy.id;
    const current = task.id ? S().getTask(task.id) : guestTask();
    const drawer = document.createElement('div');
    drawer.id = 'match-drawer';
    drawer.className = 'match-drawer';
    drawer.dataset.from = opener.dataset.from || '';
    const footer=opener.dataset.from==='recheck' ? interpretFooter(current,policy).replace(/<button type="button" class="button button-primary"[\s\S]*?<\/button>/,'') : interpretFooter(current,policy);
    drawer.innerHTML = `<button type="button" class="match-drawer-scrim" data-action="match-drawer-close" aria-label="关闭政策解读" tabindex="-1"></button><section class="match-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="match-drawer-title"><header><h2 id="match-drawer-title">政策解读</h2><button type="button" class="icon-button match-drawer-close" data-action="match-drawer-close" aria-label="关闭" title="关闭">${icon('close')}</button></header><div class="match-drawer-body" tabindex="0">${interpretCard(current, policy)}</div>${footer}</section>`;
    document.body.append(drawer);
    state.drawerReturn = opener;
    drawer.querySelector('.match-drawer-close').focus({ preventScroll: true });
  }

  /* 企业画像里的可申报数量：匹配过才有。 */
  function openCount(task) {
    if (task?.intake?.stage !== 'ready') return undefined;
    const facts = factsOf(task);
    return noHit(facts) ? 0 : openFits(facts).length;
  }

  function chatInner(task) {
    return state.taskId === task.id && state.phase === 'running' ? runningMarkup(task) : resultMarkup(task);
  }

  /* 匹配顾问的对话内容。还没收集完时，先交回资料助理。 */
  function matchChatMarkup(task) {
    if (!task?.intake) return '';
    // 企业信息在这里收集，收完接着比对。
    if (task.intake.stage !== 'ready') return intakeMarkup(task);
    // 匹配开始后，前面的问答（选几项、核对画像、确认）留在对话里，保证一问一答。
    const known = portraitRows(task).filter(([, value]) => value).length;
    const before = `${assistantBubble(`想帮「${task.company.name}」匹配政策，先了解几项情况，点选就行。`)}${userBubble(answersSummary(answersOf(task)))}${assistantBubble('请核对企业画像，确认后开始匹配。', `<div class="intake-card intake-done"><p>企业画像已了解 ${known}/${PORTRAIT_LABELS.length} 项，右侧可以查看和补充。</p></div>`)}${userBubble('确认企业信息，开始匹配')}`;
    return `${before}<div id="match-app" class="match-app">${chatInner(task)}</div>`;
  }

  const matchPending = task => Boolean(task?.intake) && !task.steps.match;

  function followChat() {
    window.PolicyChat.restoreView({ followLatest: true });
  }

  function showResult() {
    state.phase = 'result';
    state.timer = 0;
    if (!document.querySelector('#match-app')) return;
    const settle = () => {
      window.PolicyUI.refresh();
      document.querySelector('#match-result-heading')?.focus({ preventScroll: true });
    };
    if (typeof document.startViewTransition !== 'function' || reducedMotion()) { settle(); return; }
    // 页面不可见时过渡会被跳过，内容仍会更新，不算错误。
    const transition = document.startViewTransition(settle);
    transition.ready.catch(() => {});
    transition.finished.catch(() => {});
  }

  function advance() {
    if (state.stage >= groups.length) { showResult(); return; }
    state.stage += 1;
    const root = document.querySelector('#match-app');
    root?.querySelectorAll('.match-stage').forEach((node, index) => {
      node.hidden = index > state.stage;
      node.dataset.state = index === state.stage ? 'active' : 'done';
    });
    const orb = root?.querySelector('[data-orb-label]');
    if (orb) orb.textContent = '正在匹配中';
    if (root) followChat();
    state.timer = window.setTimeout(advance, stageDelay);
  }

  function setIntake(task, patch, extra = {}) {
    return S().updateTask(task.id, { ...extra, intake: { ...task.intake, ...patch } });
  }

  const resetSteps = { match: false, diagnosis: false, assembly: false, review: false };

  function refreshChat() {
    window.PolicyUI.refresh();
  }

  function showIntakeStage(task, stage) {
    setIntake(task, { stage });
    const here = location.hash.includes(task.id) && location.hash.includes('work=match');
    if (here) window.PolicyUI.refresh(); else window.PolicyUI.navigate('task', { task: task.id, work: 'match' });
  }
  const askConfirm = task => showIntakeStage(task, 'confirm');
  function startMatch(task) {
    const saved = setIntake(task, { stage: 'ready' });
    if (!saved) { window.PolicyUI.toast('资料未能保存，请重试。'); return; }
    S().confirmWork(task.id, 'profile');
    window.clearTimeout(state.timer);
    Object.assign(state, { taskId: task.id, phase: reducedMotion() ? 'result' : 'running', stage: 0, timer: 0 });
    if (state.phase === 'running') state.timer = window.setTimeout(advance, stageDelay);
    window.PolicyUI.navigate('task', { task: task.id, work: 'match' });
  }

  function handleClick(target) {
    const { action } = target.dataset;
    if (!['pick-suggest','guidance-prep','check-assign','policy-pick','policy-company-skip','policy-check-confirm','followup-submit','followup-skip','range-answer','copy-official','guidance-service','intake-confirm','service-dismiss','interpret-services-refresh','interpret-todo', 'interpret-apply', 'portrait-edit', 'portrait-cancel', 'portrait-save', 'company-edit-inline', 'company-edit-cancel', 'company-edit-save', 'home-intake-finish', 'intake-edit', 'intake-start', 'intake-remove-file', 'intake-result', 'match-chat', 'match-apply', 'match-drawer', 'match-drawer-close', 'nohit-pick', 'nohit-confirm', 'nohit-service', 'company-retry', 'interpret-retry', 'guidance-open'].includes(action)) return false;
    if (action === 'policy-pick') {
      pick.policyId = target.dataset.policy;
      window.PolicyUI.refresh();
      focusLater('.company-inline-form input');
      return true;
    }
    if (action === 'pick-suggest') {
      const box = document.querySelector('#pick-message');
      if (box) { box.value = target.dataset.text; box.form.requestSubmit(); }
      return true;
    }
    if (action === 'policy-company-skip') { startFromPick(''); return true; }
    // V2.3：办理提交里要补材料时，不跳到别的步骤，在当前会话里弹出材料收集卡片，就地上传和解析。
    if (action === 'guidance-open') {
      pushGuideStep(target.dataset.task, 'guide');
      window.PolicyUI.refresh();
      return true;
    }
    if (action === 'guidance-prep') {
      prepOpenTasks.add(target.dataset.task);
      pushGuideStep(target.dataset.task, 'prep');
      window.PolicyUI.refresh();
      return true;
    }
    if (action === 'check-assign') {
      const current = S().getTask(target.dataset.task);
      const waiting = unmatchedFiles.get(current?.id) || [];
      const picks = [...(target.closest('.check-assign')?.querySelectorAll('[data-assign-file]') || [])].map(select => ({ file: waiting[Number(select.dataset.assignFile)], to: select.value }));
      if (picks.some(entry => !entry.to)) { window.PolicyUI.toast('每个文件都选一项；不属于清单的选“不属于清单”。'); return true; }
      const assigned = picks.filter(entry => entry.to !== '__none');
      const sources = current.sources.map(source => { const hit = assigned.find(entry => entry.to === source.id); return hit ? { ...source, text: hit.file.text.trim(), provided: true, fileName: hit.file.name } : source; });
      const requirements = current.requirements.map(item => assigned.some(entry => entry.to === item.sourceId) && item.kind === 'material' ? { ...item, status: 'ready' } : item);
      S().updateTask(current.id, { sources, requirements, steps: { assembly: false, review: false } });
      unmatchedFiles.delete(current.id);
      window.PolicyUI.refresh();
      window.PolicyUI.toast(assigned.length ? `已对应 ${assigned.length} 个文件，核对结果已更新。` : '已忽略这些文件。');
      return true;
    }
    if (action === 'policy-check-confirm') {
      const current = S().getTask(target.dataset.task);
      if (!current) return true;
      const picked = Object.fromEntries([...(target.closest('.policy-check-card')?.querySelectorAll('input[type="radio"]:checked') || [])].map(input => [input.name, input.value]));
      setIntake(current, { stage: 'ready', answers: { ...answersOf(current), ...picked } });
      S().confirmWork(current.id, 'profile');
      refreshChat();
      return true;
    }
    if (action === 'followup-submit' || action === 'followup-skip') {
      const current = S().getTask(target.dataset.task);
      if (!current) return true;
      const picked = action === 'followup-skip' ? {} : Object.fromEntries([...(target.closest('.intake-followup')?.querySelectorAll('input[type="radio"]:checked') || [])].map(input => { const [kind, key, need] = input.name.split('|'); return kind === 'range' ? [rangeKey(key, need), input.value] : [input.name, input.value]; }));
      if (action === 'followup-submit' && !Object.keys(picked).length) { window.PolicyUI.toast('还没有选择，可以点“跳过”。'); return true; }
      setIntake(current, { followupDone: true, answers: { ...answersOf(current), ...picked } });
      if (action === 'followup-skip') { window.PolicyUI.refresh(); window.PolicyUI.toast('先按已有信息展示，之后可以在画像里补充。'); return true; }
      startMatch(S().getTask(current.id));
      return true;
    }
    if (action === 'range-answer') {
      const current = S().getTask(target.dataset.task);
      if (!current) return true;
      setIntake(current, { answers: { ...answersOf(current), [rangeKey(target.dataset.key || 'revenue', target.dataset.need)]: target.dataset.answer } });
      const fresh = S().getTask(current.id), policy = target.dataset.policy && publicPolicies().find(item => item.id === target.dataset.policy);
      window.PolicyUI.refresh();
      if (policy && document.querySelector('#match-drawer')) updateInterpretDrawer(fresh, policy);
      window.PolicyUI.toast(target.dataset.answer === 'unsure' ? '先按“待确认”处理，之后可以在政策详情里补充。' : '结果已更新。');
      return true;
    }
    if (action === 'copy-official') {
      const url = target.dataset.url;
      // 复制失败（嵌入页常见）时，把链接原样显示出来让用户手动复制；嵌入页不能用原生弹框。
      const showText = () => {
        let field = target.parentElement.querySelector('.guidance-fallback-url');
        if (!field) { field = document.createElement('input'); field.className = 'guidance-fallback-url'; field.readOnly = true; field.setAttribute('aria-label', '官方链接'); target.parentElement.append(field); }
        field.value = url; field.focus(); field.select();
        window.PolicyUI.toast('已显示官方链接，可以手动复制。');
      };
      try { (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => window.PolicyUI.toast('官方链接已复制。'), showText); } catch { showText(); }
      return true;
    }
    if (action === 'guidance-service') { window.PolicyUI.toast('已通知人工客服，稍后会联系您。'); return true; }
    if (action === 'service-dismiss') {
      dismissedServices.add(target.dataset.kind);
      document.querySelectorAll(`.svc-section[data-service-kind="${target.dataset.kind}"]`).forEach(node => node.remove());
      window.PolicyUI.toast('本次对话不再推荐这类服务。');
      return true;
    }
    if (action === 'match-drawer-close') { closeDrawer(); return true; }
    if (action === 'home-intake-finish') { finishHomeIntake(target.dataset.skip === '1'); return true; }
    if (action === 'interpret-services-refresh') {
      const kind = target.dataset.kind || 'patent';
      const total = kind === 'patent' ? Math.ceil(patentServices.length / serviceBatchSize) : Math.ceil((serviceCatalog[kind] || []).length / serviceBatchSize);
      serviceBatches[kind] = ((serviceBatches[kind] || 0) + 1) % total;
      const html = kind === 'patent' ? serviceCards() : kindCards(kind);
      document.querySelectorAll(`.svc-section[data-service-kind="${kind}"] .interpret-service-grid`).forEach(grid => { grid.innerHTML = html; });
      return true;
    }

    if(action==='interpret-todo') {
      const task=S().getTask(target.dataset.task),policy=publicPolicies().find(item=>item.id===target.dataset.policy);
      if(!task){closeDrawer();window.PolicyUI.navigate('dashboard');window.PolicyUI.toast('先填写企业名称，再补充企业资料。');return true;}
      if(!policy)return true;
      const key=target.dataset.key,row=comparisonRows(task,policy).find(item=>item.key===key);if(!row)return true;
      const panel=document.querySelector('#interpret-supplement');
      interpretEditKey=key==='materials'?'':key;renderComparison(task,policy);
      panel.innerHTML=key==='materials'?materialsMarkup(task,policy):'';
      if(key==='materials'){panel.scrollIntoView({block:'nearest',behavior:reducedMotion()?'instant':'smooth'});panel.querySelector('button')?.focus({preventScroll:true});return true;}
      const editor=document.querySelector('#interpret-field');editor.focus({preventScroll:true});editor.select();editor.scrollIntoView({block:'nearest',inline:'nearest'});return true;
    }
    if (!target.dataset.task && ['match-drawer', 'interpret-apply'].includes(action)) { handleGuest(action, target); return true; }
    const task = S().getTask(target.dataset.task);
    if (!task) return true;
    if (action === 'match-drawer') { openDrawer(task, target); return true; }
    if (action === 'nohit-pick') {
      const { key, value } = target.dataset, view = noHitView(task.id), next = view[key] === value ? '' : value;
      setNoHitView(task.id, { [key]: next });
      target.parentElement.querySelectorAll('.nohit-chip').forEach(chip => chip.setAttribute('aria-pressed', String(chip === target && Boolean(next))));
      const current = noHitView(task.id);
      target.closest('.match-nohit').querySelector('[data-action="nohit-confirm"]').disabled = !(current.industry || current.region);
      return true;
    }
    if (action === 'nohit-confirm') {
      const view = noHitView(task.id);
      if (!view.industry && !view.region) return true;
      setNoHitView(task.id, { applied: { industry: view.industry, region: view.region } });
      window.PolicyUI.refresh();
      document.querySelector('#match-result-heading')?.focus({ preventScroll: true });
      return true;
    }
    if (action === 'company-retry') {
      if (sim('apiTimeout')) { window.PolicyUI.toast('还是查询失败，请稍后再试。'); return true; }
      if (!S().updateTask(task.id, { company: { name: task.company.name, ...apiProfile(task.company.name) } })) { window.PolicyUI.toast('未能保存，请重试。'); return true; }
      window.PolicyUI.refresh(); window.PolicyUI.toast('已重新查询企业信息。');
      return true;
    }
    if (action === 'interpret-retry') {
      const picked = publicPolicies().find(item => item.id === target.dataset.policy);
      if (sim('interpretFail')) { window.PolicyUI.toast('白话解读还是没有生成，请稍后再试。'); return true; }
      if (picked) updateInterpretDrawer(task, picked);
      return true;
    }
    if (action === 'nohit-service') {
      setNoHitView(task.id, { service: true });
      window.PolicyUI.refresh();
      document.querySelector('.nohit-service-done')?.focus({ preventScroll: true });
      return true;
    }
    if (action === 'interpret-apply') {
      const picked = publicPolicies().find(item => item.id === target.dataset.policy);
      if (!picked || !S().updateTask(task.id, { ...chooseStep(task, picked), interpretPolicyId: picked.id })) { window.PolicyUI.toast('未能保存，请重试。'); return true; }
      closeDrawer();
      window.PolicyUI.navigate('task', { task: task.id, work: hasNoTemplate(picked) ? 'guidance' : 'assembly' });
      return true;
    }
    if (action === 'portrait-edit') { portraitEditTask = task.id; swapPortrait(task); document.querySelector('#portrait-name')?.focus({ preventScroll: true }); return true; }
    if (action === 'portrait-cancel') { portraitEditTask = ''; swapPortrait(task); return true; }
    if (action === 'portrait-save') { savePortrait(task); return true; }
    if (action === 'company-edit-inline') {
      companyInlineEditTasks.add(task.id);
      window.PolicyUI.refresh();
      document.querySelector(`#company-inline-name-${CSS.escape(task.id)}`)?.focus({ preventScroll: true });
      return true;
    }
    if (action === 'company-edit-cancel') {
      companyInlineEditTasks.delete(task.id);
      window.PolicyUI.refresh();
      return true;
    }
    if (action === 'company-edit-save') {
      const form = target.closest('.company-inline-edit');
      const name = form?.querySelector('input[id^="company-inline-name-"]')?.value.trim();
      if (!name) { window.PolicyUI.toast('请填写企业名称。'); form?.querySelector('input[id^="company-inline-name-"]')?.focus({ preventScroll: true }); return true; }
      const changed = name !== task.company.name;
      const answers = { ...answersOf(task) };
      const region = form.querySelector('input[name="inline-region"]:checked')?.value;
      const industry = form.querySelector('input[name="inline-industry"]:checked')?.value;
      if (region) answers.region = region === '其他地区' ? '' : region;
      if (industry) answers.industry = industry === '其他行业' ? '' : industry;
      const title = task.title === `${task.company.name} · 政策申报` ? `${name} · 政策申报` : task.title;
      const intake = { ...(task.intake || { stage: 'ready', files: [] }), answers };
      const newCompanyFacts = changed ? apiProfile(name) : {};
      const newAnswers = { ...answers, region: region || '', industry: industry || '' };
      if (!S().updateTask(task.id, { title, intake: { ...intake, answers: newAnswers }, ...(changed ? { company: { name, ...newCompanyFacts }, steps: { ...resetSteps, profile: false, match: false } } : {}) })) { window.PolicyUI.toast('未能保存，请重试。'); return true; }
      companyInlineEditTasks.delete(task.id);
      startMatch(S().getTask(task.id));
      window.PolicyUI.toast('已按新的企业信息重新匹配。');
      return true;
    }
    if (action === 'intake-result') { window.PolicyUI.navigate('task', { task: task.id, work: 'match' }); return true; }
    if (action === 'intake-edit') {
      setIntake(task, task.intake ? { stage: 'fields' } : { stage: 'fields', answers: {}, files: [] });
      refreshChat();
      return true;
    }
    if (action === 'intake-start') { target.dataset.skip === '1' ? startMatch(task) : askConfirm(S().getTask(task.id) || task); return true; }
    if (action === 'intake-confirm') {
      const region = target.closest('.portrait-confirm')?.querySelector('input[name="region"]:checked')?.value;
      if (region) setIntake(task, { answers: { ...answersOf(task), region } });
      startMatch(S().getTask(task.id) || task);
      return true;
    }
    if (action === 'intake-remove-file') {
      setIntake(task, { files: filesOf(task).filter(file => file.id !== target.dataset.file) });
      refreshChat();
      return true;
    }
    if (action === 'match-chat') {
      closeDrawer();
      setIntake(task, task.intake ? { stage: 'fields' } : { stage: 'fields', answers: {}, files: [] });
      window.PolicyUI.navigate('task', { task: task.id, work: 'match' });
      return true;
    }
    const policy = publicPolicies().find(item => item.id === target.dataset.policy);
    if (!policy) return true;
    closeDrawer();
    if (!S().updateTask(task.id, chooseStep(task, policy))) {
      window.PolicyUI.toast('未能选择这项政策，请重试。');
      return true;
    }
    window.PolicyUI.navigate('task', { task: task.id, work: hasNoTemplate(policy) ? 'guidance' : 'assembly' });
    return true;
  }

  /* 选完一项就露出下一项；只改动相关节点，已选项和键盘焦点都不受影响。 */
  document.addEventListener('change', event => {
    const input = event.target;
    if (input?.id === 'intake-files') {
      const task = S().getTask(input.dataset.task);
      if (!task) return;
      const added = Array.from(input.files || []).map((file, index) => ({ id: `file-${Date.now()}-${index}`, name: file.name, size: file.size }));
      Array.from(input.files || []).forEach(file => rememberUpload(file, task.id, input.closest('#adviser-chat-form')?.dataset.work || ''));
      if (added.length) { S().updateTask(task.id, { intake: { stage: 'ready', answers: {}, ...task.intake, files: [...filesOf(task), ...added].slice(-20) } }); refreshChat(); window.PolicyUI.toast('已上传。'); }
      return;
    }
    if (input?.id === 'intake-name') {
      const task = S().getTask(input.dataset.task), name = input.value.trim();
      if (!task) return;
      if (!name) { input.value = task.company.name; window.PolicyUI.toast('企业名称不能为空。'); return; }
      if (name === task.company.name) return;
      const title = task.title === `${task.company.name} · 政策申报` ? `${name} · 政策申报` : task.title;
      if (!S().updateTask(task.id, { title, company: { name, ...apiProfile(name) }, steps: resetSteps })) { window.PolicyUI.toast('企业名称未能保存，请重试。'); return; }
      window.PolicyUI.refresh();
      return;
    }
    const home = input?.closest?.('[data-home-intake]');
    if (input?.type === 'radio' && home) {
      homeIntake.answers[input.name] = input.value;
      revealNext(home, homeIntake.answers);
      return;
    }
    const form = input?.closest?.('.intake-form');
    if (input?.type !== 'radio' || !form) return;
    const task = S().getTask(form.dataset.task);
    if (!task) return;
    const answers = { ...answersOf(task), [input.name]: input.value };
    setIntake(task, { answers });
    // 画像跟着选择实时更新，不重绘对话。
    const portrait = document.querySelector('.workspace-summary');
    if (portrait) portrait.outerHTML = window.PolicyWorkspace.portraitMarkup(S().getTask(task.id));
    revealNext(form, answers);
  });

  document.addEventListener('keydown', event => {
    const drawer = document.querySelector('#match-drawer');
    if (!drawer) return;
    // 编辑中：回车和 Tab 保存，Esc 放弃修改、只退出编辑。
    if (event.target instanceof Element && event.target.id === 'interpret-field' && ['Enter','Escape','Tab'].includes(event.key)) {
      if (event.key !== 'Tab') event.preventDefault();
      if (event.key === 'Escape') cancelInterpretEdit(); else commitInterpretEdit(true);
      return;
    }
    if (event.key === 'Escape') { closeDrawer(); return; }
    if (event.key !== 'Tab') return;
    const items = [...drawer.querySelectorAll('.match-drawer-panel button:not([disabled]),.match-drawer-panel a,.match-drawer-panel input,.match-drawer-panel select,.match-drawer-panel summary,.match-drawer-panel [tabindex="0"]')];
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    else if (!drawer.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
  });
  window.addEventListener('hashchange', closeDrawer);
  // 编辑中点抽屉里的按钮或链接：先存再执行，避免保存重绘时把这次点击吞掉。
  document.addEventListener('focusout', event => { if (event.target instanceof Element && event.target.id === 'interpret-field') commitInterpretEdit(); });
  document.addEventListener('mousedown', event => {
    if (interpretEditKey && event.target instanceof Element && event.target.closest('#match-drawer button,#match-drawer a')) event.preventDefault();
  }, true);
  document.addEventListener('click', event => {
    if (!interpretEditKey || !(event.target instanceof Element) || event.target.id === 'interpret-field' || !document.querySelector('#interpret-field')) return;
    const link = event.target.closest('a[href]');
    commitInterpretEdit();
    if (link && !link.isConnected) window.open(link.href, '_blank', 'noopener');
  }, true);

  /* ---------- V2.3 入口 2「准备申报材料」、入口 3「核对并提交」：先问政策，再问企业 ---------- */
  // 政策模糊查询在本产品的政策要素库里做：文号或原文链接精确匹配 → 名称 → 简称、关键词和摘要，取前 3 条。
  const pick = { work: '', query: '', results: null, policyId: '' };
  const POLICY_STATUS = { open: '正在申报', notice: '暂未开放', closed: '已截止' };
  const PICK_GREETING = {
    assembly: '您要申报哪项政策？输入政策名称或关键词就行，比如“住建领域创新应用场景”“重点应用场景”。',
    guidance: '材料准备好了？先告诉我申报哪项政策，我帮您核对材料是否齐全，再告诉您去哪里提交。',
  };
  function searchPolicies(query) {
    const q = query.trim().toLowerCase().replace(/\s+/g, '');
    if (!q) return [];
    const grams = q.length < 2 ? [q] : [...Array(q.length - 1)].map((_, index) => q.slice(index, index + 2));
    const order = { open: 0, notice: 1, closed: 2 };
    return publicPolicies().filter(policy => !policy.noPolicy).map(policy => {
      const name = (policy.title || '').toLowerCase();
      const more = [policy.summary, policy.agency, policy.region, policy.supportType, ...(policy.industries || []), ...(policy.keywords || []), policy.documentNumber || ''].join(' ').toLowerCase();
      let score = 0;
      const exact = Boolean(policy.sourceUrl && q.includes(policy.sourceUrl.toLowerCase().replace(/\s+/g, ''))) || more.includes(q);
      if (exact) score += 40;
      if (name.includes(q)) score += 50;
      const titleHits = grams.filter(gram => name.includes(gram)).length;
      score += titleHits * 3;
      // 名称里至少命中一半关键词，或整个关键词出现在政策要素里，才算相关，避免只沾一两个字的结果。
      return { policy, score, status: statusOf(policy), relevant: exact || name.includes(q) || titleHits >= Math.ceil(grams.length / 2) };
    }).filter(item => item.relevant)
      .sort((a, b) => b.score - a.score || order[a.status] - order[b.status]).slice(0, 3);
  }
  const searchForm = (work, value = '') => `<form id="policy-search-form" class="intake-card policy-search-form" data-work="${esc(work)}"><div class="intake-name-row"><label for="policy-query">政策名称</label><input id="policy-query" name="q" type="text" maxlength="200" autocomplete="off" placeholder="输入政策名称、关键词、文号或原文链接" value="${esc(value)}"></div><div class="intake-foot is-end"><button type="submit" class="button button-primary">查找政策 ${icon('arrow')}</button></div></form>`;
  function pickResultsMarkup(work) {
    const { results, query } = pick;
    if (!results.length) {
      return assistantBubble(`没有找到和“${query}”相关的政策，这项政策可能暂未收录。`, `<div class="intake-card policy-pick-empty"><p>可以在下方换个关键词再查，或者告诉我企业名称，我帮您找能申报的政策。</p><div class="policy-pick-alt"><a href="#dashboard?work=interpret" data-action="nav-work" data-work="interpret">按企业找政策</a><button type="button" class="text-button" data-action="guidance-service">联系人工客服</button></div></div>`, work);
    }
    const rows = results.map(({ policy, status }, index) => `<button type="button" class="policy-pick${pick.policyId === policy.id ? ' is-picked' : ''}" data-action="policy-pick" data-policy="${esc(policy.id)}"${pick.policyId ? ' disabled' : ''}><span class="policy-pick-no">${index + 1}</span><span class="policy-pick-text"><strong>${esc(policy.title)}</strong><small>${esc(policy.region)} · ${esc(windowText(policy))} · <em class="is-${status}">${POLICY_STATUS[status]}</em></small></span></button>`).join('');
    const none = pick.policyId ? '' : `<a class="policy-pick policy-pick-none" href="#dashboard?work=interpret" data-action="nav-work" data-work="interpret"><span class="policy-pick-text"><strong>都不是，帮我按企业找</strong><small>告诉我企业名称，我帮您找能申报的政策</small></span></a>`;
    return assistantBubble(`找到 ${results.length} 项相关政策，选一项：`, `<div class="intake-card policy-pick-list">${rows}${none}</div>`, work);
  }
  function companyAsk(work, policy, readonly = false) {
    const status = statusOf(policy);
    const note = status === 'closed' ? '这项政策本期已截止，可以为下一批提前准备。' : status === 'notice' ? (ongoing(policy) ? '这项政策按纳税期常态办理，不是集中申报。' : '这项政策暂未开放申报，开放后再来申报。') : '';
    const why = work === 'guidance' ? '<p class="policy-company-why">填了企业名称，我会核对材料里的企业信息和工商信息是否一致；不填也能核对材料和看办事指南。</p>' : '';
    const form = readonly ? '' : `<form class="company-inline-form" data-work="${esc(work)}"><input name="companyName" aria-label="企业名称" placeholder="输入企业全称" maxlength="300" autocomplete="organization"><button type="submit" class="button button-primary">确定</button>${work === 'guidance' ? '<button type="button" class="text-button" data-action="policy-company-skip">先跳过</button>' : ''}</form>`;
    if (!readonly) focusLater('.company-inline-form input');
    return assistantBubble(`好的。${note}这项政策给哪家企业申报？`, why || form ? `<div class="intake-card policy-company-note">${why}${form}</div>` : '', work);
  }
  function policyFirstMarkup(work) {
    if (pick.work !== work) Object.assign(pick, { work, query: '', results: null, policyId: '' });
    const policy = pick.policyId && publicPolicies().find(item => item.id === pick.policyId);
    return assistantBubble(PICK_GREETING[work], '', work)
      + (pick.results === null ? '' : userBubble(pick.query) + pickResultsMarkup(work))
      + (policy ? userBubble(policy.title) + companyAsk(work, policy) : '');
  }
  /* 入口 2、3 的输入框在对话下方：没选政策时输入政策名称，选了政策后输入企业名称。 */
  function pickComposer(work) {
    const choosingCompany = Boolean(pick.policyId && pick.work === work);
    const chips = choosingCompany
      ? ''
      : ['住建领域创新应用场景', '重点应用场景'].map(text => `<button type="button" data-action="pick-suggest" data-text="${esc(text)}">${esc(text)}</button>`).join('');
    const placeholder = choosingCompany ? '输入企业全称' : pick.results ? '换个关键词再查，或输入政策名称、文号、原文链接' : '输入政策名称、关键词、文号或原文链接';
    return `<div class="chat-composer pick-composer"><div class="chat-suggestions">${chips}</div><form id="pick-composer-form" data-work="${esc(work)}" data-mode="${choosingCompany ? 'company' : 'policy'}"><label class="sr-only" for="pick-message">${choosingCompany ? '企业名称' : '政策名称'}</label><textarea id="pick-message" name="message" rows="1" maxlength="300" placeholder="${esc(placeholder)}"></textarea><button type="submit" class="icon-button chat-send" aria-label="发送">${icon('arrow')}</button></form></div>`;
  }
  function resetPick() { Object.assign(pick, { work: '', query: '', results: null, policyId: '' }); }
  function focusLater(selector) { requestAnimationFrame(() => { const el = document.querySelector(selector); el?.focus?.({ preventScroll: true }); }); }

  // 选好政策、拿到企业后才建任务；同一企业同一政策已有任务就接着做。
  function startFromPick(name) {
    const policy = publicPolicies().find(item => item.id === pick.policyId);
    if (!policy) return;
    const work = pick.work;
    const existing = name && S().getState().tasks.find(task => task.company.name === name && task.policyId === policy.id && task.steps.match);
    const target = work === 'assembly' && !hasNoTemplate(policy) ? 'assembly' : 'guidance';
    if (existing) {
      resetPick();
      window.PolicyUI.toast('这家企业已经在准备这项政策，接着上次的继续。');
      window.PolicyUI.navigate('task', { task: existing.id, work: target });
      return;
    }
    const task = S().createTask({
      title: name ? `${name} · ${policy.title}` : policy.title,
      request: `为${name || '企业'}准备「${policy.title}」的申报。`,
      company: name ? { name, ...apiProfile(name) } : { name: '', region: '', industry: '' },
      entry: work,
      intake: { stage: work === 'assembly' ? 'policy-check' : 'ready', answers: {}, files: [] },
    });
    if (!task || !S().updateTask(task.id, { ...chooseStep(task, policy), interpretPolicyId: policy.id })) { window.PolicyUI.toast('未能创建，请重试。'); return; }
    if (name) S().confirmWork(task.id, 'profile');
    resetPick();
    window.PolicyUI.navigate('task', { task: task.id, work: target });
  }

  /* 入口 2：只核对这条政策要看的条件，接口已有的预填，缺的就地点选。 */
  function policyCheckRows(task, policy) {
    const facts = factsOf(task), answers = answersOf(task), data = mockCompanyData(task) || {};
    const chips = (key, options, current) => `<div class="match-options">${options.map(option => `<label class="match-option"><input type="radio" name="${key}" value="${esc(option)}"${current === option ? ' checked' : ''}><span>${esc(option)}</span></label>`).join('')}</div>`;
    const known = (value, from) => `<span class="policy-check-value">${esc(value)}<small>${from}</small></span>`;
    const rows = [
      ['所在地区', policy.region === '全国' ? '不限地区' : policy.region, facts.region ? known(facts.region, '企业接口') : chips('region', [...fieldOptions('region'), '其他地区'], '')],
      ['所属行业', policy.industries.join('、') || '以原文为准', facts.industry ? known(facts.industry, '企业接口') : chips('industry', [...fieldOptions('industry'), '其他行业'], '')],
    ];
    policyRules(policy).forEach(rule => {
      const need = `≥ ${rule.need}${rule.unit === '%' ? '' : ' '}${rule.unit}`;
      if (rule.interval) {
        const question = questions.find(item => item.key === rule.key);
        rows.push([rule.label, need, answers[rule.key] ? known(answers[rule.key], '您填写的') : chips(rule.key, question.options, '')]);
      } else {
        const have = data[rule.key];
        rows.push([rule.label, need, have === null || have === undefined ? '<span class="policy-check-value is-empty">待核实<small>可在政策详情里补充</small></span>' : known(`${have} ${rule.unit}`, '企业接口')]);
      }
    });
    return rows;
  }
  function policyCheckMarkup(task) {
    if (task.entry !== 'assembly' || task.intake?.stage !== 'policy-check') return '';
    const policy = publicPolicies().find(item => item.id === task.policyId);
    if (!policy) return '';
    const rows = policyCheckRows(task, policy).map(([label, need, value]) => `<div class="policy-check-row"><span class="policy-check-label">${esc(label)}</span><span class="policy-check-need">${esc(need)}</span><span class="policy-check-have">${value}</span></div>`).join('');
    const head = `<div class="policy-check-row is-head"><span>条件</span><span>政策要求</span><span>企业现状</span></div>`;
    return assistantBubble(task.company.name ? '查到了。这项政策要看下面几项，请核对：' : '这项政策要看下面几项，请补充：', `<div class="intake-card policy-check-card" data-task="${esc(task.id)}">${head}${rows}<div class="intake-foot is-end"><button type="button" class="button button-primary" data-action="policy-check-confirm" data-task="${esc(task.id)}">确认，开始准备材料 ${icon('arrow')}</button></div></div>`, 'assembly');
  }
  /* 入口 2 确认后：只给这条政策的匹配度；地区、行业对不上时提示，不拦截。 */
  /* 旧任务：已保存的匹配结果不重算；选定的政策已截止时出提示，材料和版本照常可看、可下载（PRD V2.2 8.1.1）。 */
  function expiredNotice(task) {
    const policy = task?.steps?.match ? publicPolicies().find(item => item.id === task.policyId) : null;
    if (!policy || statusOf(policy) !== 'closed') return '';
    return assistantBubble('这项政策已截止，本期无法申报。', `<div class="intake-card policy-expired"><p>已准备的材料和版本照常可以查看、下载。</p><a class="text-button" href="${esc(policy.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看政策原文 ${icon('arrow')}</a></div>`, 'guidance');
  }
  function policyCheckParts(task) {
    if (task.entry !== 'assembly' || task.intake?.stage === 'policy-check') return '';
    const policy = publicPolicies().find(item => item.id === task.policyId);
    if (!policy) return '';
    const facts = factsOf(task), result = policyScore(task, policy);
    const misses = [];
    if (facts.region && policy.region !== '全国' && facts.region !== policy.region) misses.push(`这项政策面向${policy.region}，您的企业在${facts.region}`);
    if (industryMiss(task, policy)) misses.push(`政策支持的行业不含${facts.industry}，申报前核对`);
    const warn = misses.length ? `<div class="policy-check-warn"><p>${esc(misses.join('；'))}。可以换一项政策，也可以继续准备。</p><a href="#dashboard?work=assembly" data-action="nav-work" data-work="assembly">换一项政策</a></div>` : '';
    const pending = result?.pending ? `<p class="policy-check-pending">还有 ${result.pending} 项待补充，补充后匹配度更准。<button type="button" class="text-button" data-action="match-drawer" data-task="${esc(task.id)}" data-policy="${esc(policy.id)}">查看条件对照</button></p>` : '';
    const card = warn || pending || rangeAskInline(task, policy) ? `<div class="intake-card policy-check-result">${warn}${rangeAskInline(task, policy)}${pending}</div>` : '';
    const head = misses.length ? `「${policy.title}」对照完了：匹配度 ${result?.grade || '暂无法判断'}，${misses.length ? '有一项要先核对' : ''}。` : `「${policy.title}」对照完了：匹配度 ${result?.grade || '暂无法判断'}。`;
    return { text: `${head}下面按清单准备材料。`, card };
  }
  function policyCheckNote(task) {
    const parts = policyCheckParts(task);
    return parts ? assistantBubble(parts.text, parts.card, 'assembly') : '';
  }

  /* 入口 3：按清单核对已备好的材料（完整度 + AI 诊断），再看办事指南。 */
  function materialCheck(task, policy) {
    const items = (policy.application?.checklist || []).filter(item => item.kind !== 'condition');
    return items.map(item => {
      const source = task.sources.find(entry => entry.id === `${policy.id}-${item.id}`);
      const required = item.required !== false;
      if (!source?.provided) return { item, source, required, state: 'lack', notes: [] };
      const review = reviewMaterial(task, source);
      if (item.media) return { item, source, required, state: 'ok', notes: [] };
      if (review.unreadable) return { item, source, required, state: 'warn', notes: ['读不出文字，请人工核对内容，或上传 Word、文本版'] };
      const notes = review.missing.length ? [`没写“${review.missing.join('”“')}”`] : [];
      if (!/\d/.test(review.original)) notes.push('全文没有金额、人数或时间，不好核实');
      if (review.pending?.length) notes.push(`还有待补充：${review.pending.join('、')}`);
      // 填了企业名称才做一致性核对：材料里出现的公司名要和工商信息一致。
      const names = [...new Set(review.original.match(/[\u4e00-\u9fa5（）()]{2,30}?(?:股份有限公司|有限责任公司|有限公司)/g) || [])];
      if (task.company.name && names.length && !names.includes(task.company.name)) notes.push(`材料里写的是“${names[0]}”，和工商信息“${task.company.name}”不一致`);
      const severe = (item.expects || []).length > 0 && review.missing.length * 2 > item.expects.length;
      return { item, source, required, state: notes.length ? 'warn' : 'ok', notes, severe };
    });
  }
  const unmatchedFiles = new Map();
  const prepOpenTasks = new Set();
  const prepOpen = taskId => prepOpenTasks.has(taskId);
  /* 入口 2、3：选政策、填企业名发生在建任务之前，任务对话开头按顺序还原，保证一问一答。 */
  function pickTranscript(task, workId) {
    const work = task?.entry;
    if (!['assembly', 'guidance'].includes(work) || workId !== work) return '';
    const policy = publicPolicies().find(item => item.id === task.policyId);
    if (!policy) return '';
    const done = work === 'assembly' && task.intake?.stage !== 'policy-check';
    // 入口 2 确认后，核对条件那张卡片留在对话里（只读），后面接用户的“确认”。
    const checked = done ? assistantBubble(task.company.name ? '查到了。这项政策要看下面几项，请核对：' : '这项政策要看下面几项，请补充：', `<div class="intake-card policy-check-card is-done"><div class="policy-check-row is-head"><span>条件</span><span>政策要求</span><span>企业现状</span></div>${policyCheckRows(task, policy).map(([label, need, value]) => `<div class="policy-check-row"><span class="policy-check-label">${esc(label)}</span><span class="policy-check-need">${esc(need)}</span><span class="policy-check-have">${value}</span></div>`).join('')}</div>`, 'assembly') + userBubble('确认，开始准备材料') : '';
    return assistantBubble(PICK_GREETING[work], '', work) + userBubble(policy.title) + companyAsk(work, policy, true) + userBubble(task.company.name || '先跳过企业名称') + checked;
  }
  /* 入口 2 确认后：匹配度写在材料卡片开头，和材料清单是同一张卡片。 */
  function policyCheckLead(task) {
    const parts = policyCheckParts(task);
    return parts ? `<div class="prep-lead"><p>${esc(parts.text)}</p>${parts.card}</div>` : '';
  }
  /* 入口 3：核对结果之后，“看办事指南”“去补写”按用户点的先后各出一张卡片。 */
  const guideOrder = new Map();
  const guideSteps = taskId => guideOrder.get(taskId) || [];
  const pushGuideStep = (taskId, step) => { const list = guideSteps(taskId).filter(item => item !== step); guideOrder.set(taskId, [...list, step]); };
  function guidanceCheckMarkup(task) {
    // 找政策进来的任务走原来的“检查申报材料”；整理申报材料、办理指引进来的，在办理提交这一步先核对材料。
    if (!task.entry || task.entry === 'match') return '';
    const policy = task.steps.match ? publicPolicies().find(item => item.id === task.policyId) : null;
    if (!policy) return '';
    const rows = materialCheck(task, policy);
    const required = rows.filter(row => row.required);
    const lack = required.filter(row => row.state === 'lack'), warn = rows.filter(row => row.state === 'warn');
    const uploaded = rows.some(row => row.state !== 'lack');
    const id = esc(task.id);
    // 每一项复用“申报材料”的材料卡（上传完整文件 / 批量上传，AI 生成 / 重新上传 / 删除），核对出的问题写在卡片下面。
    // 外层复用申报材料的卡头、进度和必需/选填分组；核对出的问题写在对应卡片下面。
    const issuesBy = new Map();
    const toReq = ({ item, state, notes, required: isRequired }) => {
      const sid = `${policy.id}-${item.id}`;
      const found = task.requirements.find(entry => entry.sourceId === sid);
      const req = found || { id: sid, label: item.label, status: state === 'lack' ? 'missing' : 'ready', kind: 'material', sourceId: sid, required: isRequired };
      // 核对结论直接写进这份材料的“AI 建议”，“去补写”放在建议标题行，不再在卡片下面另起一段。
      if (state === 'warn' && notes.length) issuesBy.set(sid, { warn: true, text: `${notes.join('；')}。`, action: `<button type="button" class="text-button prep-advice-fix" data-action="guidance-prep" data-task="${id}">去补写</button>` });
      return req;
    };
    const list = window.PolicyChat.prepSections(task, { required: required.map(toReq), optional: rows.filter(row => !row.required).map(toReq), advice: req => issuesBy.get(req.sourceId) || null });
    const ok = required.length - lack.length;
    const text = !uploaded
      ? '把准备好的文件传上来，我帮您核对。'
      : !lack.length && !warn.length ? `核对结果：${required.length} 项必需材料都齐了，没有发现明显问题。点“看办事指南”去提交。`
      : `核对结果：${required.length} 项必需材料已齐 ${ok} 项${lack.length ? `，缺${lack.map(row => row.item.label).join('、')}` : ''}${warn.length ? `；${warn.length} 项有问题` : ''}。`;
    const severe = policyScore(task, policy)?.grade === '低' ? '<p class="precheck-severe">这项政策匹配度为低，建议暂缓申报，先补齐条件。仍可以继续看办事指南。</p>' : '';
    const latest = S().getState().versions.filter(version => version.taskId === task.id && version.status === 'confirmed').sort((a, b) => b.number - a.number)[0];
    const reuse = latest ? `<p class="check-reuse">平台里已有确认的材料 V${latest.number}，直接用它核对，不用再传。</p>` : '';
    const waiting = unmatchedFiles.get(task.id) || [];
    const assign = waiting.length ? `<div class="check-assign"><p>这 ${waiting.length} 个文件没对上清单，选一下分别是哪一项：</p>${waiting.map((file, index) => `<label class="check-assign-row"><span>${esc(file.name)}</span><select data-assign-file="${index}"><option value="">选一项</option>${rows.map(({ item }) => `<option value="${esc(`${policy.id}-${item.id}`)}">${esc(item.label)}</option>`).join('')}<option value="__none">不属于清单，不用核对</option></select></label>`).join('')}<div class="intake-foot is-end"><button type="button" class="button button-primary" data-action="check-assign" data-task="${id}">确定</button></div></div>` : '';
    const guideBtn = guideSteps(task.id).includes('guide') ? '' : `<div class="intake-foot is-end"><button type="button" class="button button-primary" data-action="guidance-open" data-task="${id}">看办事指南</button></div>`;
    return assistantBubble(text, `<div class="intake-card check-card">${scoreLine(task,policy,{from:'recheck'})}${reuse}${severe}${assign}${list}<p class="precheck-note">AI 诊断按政策要求逐项检查，结论不构成官方审核意见</p>${guideBtn}</div>`, 'guidance');
  }
  // 一次传多个：按文件名对应清单项；对不上的提示单独上传。
  function bulkCheckUpload(input) {
    const task = S().getTask(input.dataset.task);
    const policy = task && publicPolicies().find(item => item.id === task.policyId);
    if (!policy) return;
    const items = (policy.application?.checklist || []).filter(item => item.kind !== 'condition');
    const grams = text => { const t = text.replace(/\s+/g, ''); return t.length < 2 ? [t] : [...Array(t.length - 1)].map((_, i) => t.slice(i, i + 2)); };
    const used = new Set(), unmatched = [];
    const jobs = Array.from(input.files || []).map(file => {
      const base = file.name.replace(/\.[^.]+$/, '');
      const best = items.filter(item => !used.has(item.id)).map(item => ({ item, score: grams(item.label).filter(gram => base.includes(gram)).length })).sort((a, b) => b.score - a.score)[0];
      if (!best || !best.score) { unmatched.push(file); return null; }
      used.add(best.item.id);
      return window.PolicyMaterials.readFileText(file).then(text => ({ id: `${policy.id}-${best.item.id}`, text: text || `【已上传文件：${file.name}，请人工核对内容】`, fileName: file.name }));
    }).filter(Boolean);
    const leftovers = Promise.all(unmatched.map(file => window.PolicyMaterials.readFileText(file).then(text => ({ name: file.name, text: text || `【已上传文件：${file.name}，请人工核对内容】` }))));
    Promise.all([Promise.all(jobs), leftovers]).then(([done, rest]) => {
      if (rest.length) unmatchedFiles.set(task.id, [...(unmatchedFiles.get(task.id) || []), ...rest]);
      const fresh = S().getTask(task.id);
      const sources = fresh.sources.map(source => { const hit = done.find(entry => entry.id === source.id); return hit ? { ...source, text: hit.text.trim(), provided: true, fileName: hit.fileName } : source; });
      const requirements = fresh.requirements.map(item => done.some(entry => entry.id === item.sourceId) && item.kind === 'material' ? { ...item, status: 'ready' } : item);
      S().updateTask(task.id, { sources, requirements, steps: { assembly: false, review: false } });
      window.PolicyUI.refresh();
      window.PolicyUI.toast(rest.length ? `已对应 ${done.length} 个文件；${rest.length} 个没对上清单，请选一下是哪一项。` : `已上传并对应 ${done.length} 个文件。`);
    });
  }
  document.addEventListener('change', event => { if (event.target instanceof Element && event.target.matches('[data-bulk-check]')) bulkCheckUpload(event.target); });
  document.addEventListener('keydown', event => {
    if (event.target?.id !== 'pick-message' || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    event.target.form?.requestSubmit();
  });
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || (!form.matches('.company-inline-form') && !['policy-search-form', 'policy-company-form', 'pick-composer-form'].includes(form.id))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (form.matches('.company-inline-form') || form.id === 'pick-composer-form' && form.dataset.mode === 'company') {
      const name = form.querySelector('[name="companyName"], #pick-message').value.trim();
      if (!name) { window.PolicyUI.toast(pick.work === 'guidance' ? '请填写企业名称，或点“先跳过”。' : '请填写企业名称。'); return; }
      startFromPick(name);
      return;
    }
    if (form.id === 'pick-composer-form') {
      const value = form.querySelector('#pick-message').value.trim();
      if (!value) return;
      Object.assign(pick, { work: form.dataset.work, query: value, results: searchPolicies(value), policyId: '' });
      window.PolicyUI.refresh();
      focusLater('#pick-message');
      return;
    }
    if (form.id === 'policy-search-form') {
      const query = form.querySelector('#policy-query').value.trim();
      if (!query) { window.PolicyUI.toast('请输入政策名称或关键词。'); return; }
      Object.assign(pick, { work: form.dataset.work, query, results: searchPolicies(query), policyId: '' });
      window.PolicyUI.refresh();
      focusLater(pick.results.length ? '.policy-pick' : '#policy-query');
      return;
    }
    const name = form.querySelector('#policy-company-name').value.trim();
    if (!name) { window.PolicyUI.toast(pick.work === 'guidance' ? '请填写企业名称，或点“先跳过”。' : '请填写企业名称。'); return; }
    startFromPick(name);
  }, true);

  /* 政策的材料清单改了以后，已经选过这项政策的任务按新清单刷新：已上传的资料保留，新清单里没有的空项去掉。 */
  function syncApplications() {
    (S()?.getState().tasks || []).forEach(task => {
      const policy = publicPolicies().find(item => item.id === task.policyId);
      const items = policy?.application?.checklist;
      if (!items) return;
      const want = items.filter(item => item.kind !== 'condition').map(item => `${policy.id}-${item.id}`);
      const have = (task.requirements || []).filter(item => item.kind === 'material').map(item => item.id);
      if (want.length === have.length && want.every((id, index) => id === have[index])) return;
      const patch = applicationPatch(task, policy);
      const sources = patch.sources.filter(source => source.provided || want.includes(source.id) || !source.id.startsWith(`${policy.id}-`));
      S().updateTask(task.id, { sources, requirements: patch.requirements });
    });
  }
  try { syncApplications(); } catch (error) { console.error('材料清单同步失败', error); }

  window.PolicyMatch = Object.freeze({ statusOf, daysLeft, windowText, confOf, pickTranscript, policyCheckLead, guideSteps, userBubble, expiredNotice, pickComposer, prepOpen, policyFirstMarkup, policyCheckMarkup, policyCheckNote, guidanceCheckMarkup, resetPick, stepInfo, apiProfile, portraitRows, PORTRAIT_LABELS, companyNotFound, resetGuest, noTemplateNotice, quickIntakeMarkup, assemblyPicker, refreshMaterialReview, forgetUpload, closeDrawer, handleClick, intakeActive, intakeMarkup, matchChatMarkup, matchPending, openCount, composerAttach, questions, understanding, beginPortrait, portraitLoading, portraitEditing, portraitEditor, scoreText, scoreLine, openMaterialReview, reviewMaterial, materialAdvice, maskedHtml, companyRows, policyMetrics, openHomeIntake, homeIntakeMarkup, rememberUpload, adoptUploads, uploadsMarkup, interpretMarkup, interpretPicking, guestMarkup, guestAsk, finishGuest, applicationIntro, applicationNote, guidanceMarkup, guidanceDetail, policyDetail, versionReview });
})();
